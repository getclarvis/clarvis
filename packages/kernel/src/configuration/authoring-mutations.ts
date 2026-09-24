import {
  OPERATOR_AUTHORITY_PORT,
  type RunCapabilityContext,
  type Logger,
} from "@clarvis/capability";
import { configurationTarget, type ConfigurationRoot } from "@clarvis/paths";
import type { ExtensionProfileSkillRef } from "@clarvis/protocol";
import { applyOpsAtomic, scanSmallTree, ToolError, type MutationReview } from "@clarvis/tools";
import type { ResolvedFilesystemPolicy } from "@clarvis/tools/sandbox";
import { createHash } from "node:crypto";
import { lstatSync, opendirSync, readFileSync, rmdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fsyncDir } from "@clarvis/paths";
import type { ConfigStore } from "../config/config-store.ts";
import type { PreparedSkillInclusion } from "../extension-profiles/extension-profile-manager.ts";
import type { ConfigurationMutationFacts } from "../guard/effects/configuration.ts";
import {
  configurationSkillRef,
  prepareConfigurationFileMutation,
  readConfigurationDocument,
} from "./files.ts";
import { createConfigurationReview } from "./review.ts";

/** Review complete file-tool batches through the same host authority as the restricted writer. */
export function createAuthoringMutationReview(
  ctx: RunCapabilityContext,
  options: {
    roots: Readonly<Record<ConfigurationRoot, string>>;
    store: ConfigStore;
    audit?: Logger;
    changed(path: string): void;
    prepareSkillInclusion(
      refs: readonly ExtensionProfileSkillRef[],
    ): PreparedSkillInclusion | undefined;
  },
): MutationReview {
  const review = createConfigurationReview(ctx, options);
  const digest = (content: Buffer | string): string =>
    createHash("sha256").update(content).digest("hex");
  const locate = (path: string) => configurationTarget(options.roots, path);
  const capture = (path: string): Buffer | null => {
    const target = locate(resolve(path));
    if (target !== undefined) {
      const document = readConfigurationDocument(options.roots, target.root, target.path);
      return document?.bytes ?? null;
    }
    let parent = path;
    while (true) {
      try {
        const stat = lstatSync(parent);
        if (stat.isSymbolicLink())
          throw new ToolError("denied", "Configuration cannot traverse symbolic links.");
        if (parent === path && (stat.nlink > 1 || stat.size > 262144))
          throw new ToolError("too_large", "Configuration requires a bounded, unaliased document.");
        if (parent === path && !stat.isFile())
          throw new ToolError("not_a_file", "Configuration requires a regular file target.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    try {
      const bytes = readFileSync(path);
      if (bytes.length > 262144)
        throw new ToolError("too_large", "Configuration file exceeds the review payload limit.");
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const captureEmptyDirectory = (path: string): string => {
    let parent = path;
    while (true) {
      let stat;
      try {
        stat = lstatSync(parent, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new ToolError("not_found", "Directory disappeared before review.");
        throw error;
      }
      if (stat.isSymbolicLink())
        throw new ToolError("denied", "Configuration cannot traverse symbolic links.");
      if (parent === path && !stat.isDirectory())
        throw new ToolError("invalid_input", "Empty-directory removal requires a directory.");
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    const directory = opendirSync(path);
    try {
      if (directory.readSync() !== null)
        throw new ToolError("invalid_input", "Directory is not empty.");
    } finally {
      directory.closeSync();
    }
    const stat = lstatSync(path, { bigint: true });
    return digest(
      JSON.stringify([
        stat.dev.toString(),
        stat.ino.toString(),
        stat.mode.toString(),
        stat.mtimeNs.toString(),
        stat.ctimeNs.toString(),
      ]),
    );
  };
  const authoring: MutationReview = async (operations, commit) => {
    if (operations.some((op) => op.type === "rmtree")) {
      if (operations.length !== 1 || operations[0]?.type !== "rmtree")
        throw new ToolError(
          "invalid_input",
          "Recursive cleanup must be a single reviewed operation.",
        );
      const operation = operations[0];
      const path = resolve(operation.path);
      const local = relative(ctx.workspaceRoot, path);
      if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`))
        throw new ToolError("denied", "Recursive cleanup requires a workspace target.");
      const snapshot = scanSmallTree(path);
      if (
        snapshot.revision !== operation.treeRevision ||
        JSON.stringify(snapshot.entries) !== JSON.stringify(operation.treeEntries)
      )
        throw new ToolError("revision_conflict", "Directory tree changed before review.");
      for (const entry of snapshot.entries) {
        const candidate = entry === "." ? path : resolve(path, entry);
        if (locate(candidate) !== undefined)
          throw new ToolError("denied", "Recursive cleanup cannot include configuration targets.");
      }
      const preview = snapshot.entries.map((entry) =>
        entry === "." ? path : resolve(path, entry),
      );
      await review(
        [
          {
            canonicalPath: path,
            root: "workspace",
            expectedRevision: snapshot.revision,
            nextRevision: null,
            bytes: 0,
            operation: "delete",
            fieldClass: "bounded_tree",
            surface: "tree",
            environmentDigest: digest(
              JSON.stringify([
                ctx.executionId,
                ctx.workspaceRoot,
                options.store.readSettings().merged.sandbox ?? null,
              ]),
            ),
          },
        ],
        { operation: "delete", paths: preview },
        `Review recursive cleanup of ${preview.length} entries:\n${preview.join("\n")}`,
        { offerSession: false },
      );
      let current;
      try {
        current = scanSmallTree(path);
      } catch (error) {
        if (error instanceof ToolError && error.code === "not_found")
          throw new ToolError("revision_conflict", "Directory tree changed during review.");
        throw error;
      }
      if (
        current.revision !== snapshot.revision ||
        JSON.stringify(current.entries) !== JSON.stringify(snapshot.entries)
      )
        throw new ToolError("revision_conflict", "Directory tree changed during review.");
      ctx.signal?.throwIfAborted();
      await commit();
      options.changed(path);
      return;
    }
    const paths = operations.flatMap((op) => [
      op.path,
      ...(op.from === undefined ? [] : [op.from]),
    ]);
    if (!paths.some((path) => locate(resolve(path)) !== undefined)) return commit();
    if (operations.length > 128 || new Set(paths).size !== paths.length)
      throw new ToolError(
        "invalid_input",
        "Configuration batch is too large or changes a target more than once.",
      );
    const facts: ConfigurationMutationFacts[] = [];
    const snapshots = new Map<string, string | null>();
    const directorySnapshots = new Map<string, string>();
    const initial = new Map<string, Buffer | null>();
    const captureInitial = (path: string): Buffer | null => {
      const canonical = resolve(path);
      if (initial.has(canonical)) return initial.get(canonical) ?? null;
      const bytes = capture(canonical);
      initial.set(canonical, bytes);
      return bytes;
    };
    const inclusions: ExtensionProfileSkillRef[] = [];
    const prepared: {
      path: string;
      content: string | null;
      operation: "write" | "edit" | "delete";
    }[] = [];
    const add = (
      path: string,
      content: string | null,
      operation: "write" | "edit" | "delete" = content === null ? "delete" : "write",
    ): void => {
      path = resolve(path);
      const local = relative(ctx.workspaceRoot, path);
      const inWorkspace = !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`);
      const target = locate(path);
      if (!inWorkspace && target === undefined)
        throw new ToolError("denied", "File-tool batch target is outside the admitted roots.");
      if (target !== undefined && target.kind !== "authoring" && target.kind !== "operational")
        throw new ToolError(
          target?.kind === "reserved_unknown" ? "unrecognized_configuration_target" : "denied",
          `Configuration target is not writable: ${path}.`,
        );
      const before = captureInitial(path);
      const expected = before === null ? null : digest(before);
      snapshots.set(path, expected);
      if (target !== undefined) {
        const validated = prepareConfigurationFileMutation(
          options.roots,
          {
            ...target,
            operation: content === null ? "delete" : "write",
            ...(content === null ? {} : { content }),
            expected_revision: expected,
          },
          {
            root: options.roots[target.root],
            parts: target.path.split("/"),
            current:
              before === null
                ? null
                : { content: before.toString("utf8"), revision: digest(before) },
          },
        ).facts;
        const fact = { ...validated, operation };
        facts.push(fact);
        if (expected === null && content !== null) {
          const ref = configurationSkillRef(options.roots, target.root, target.path, content);
          if (ref !== undefined) inclusions.push(ref);
        }
      } else {
        if (content !== null && Buffer.byteLength(content) > 262144)
          throw new ToolError("too_large", "Configuration batch file exceeds the review limit.");
        facts.push({
          canonicalPath: path,
          root: "workspace",
          expectedRevision: expected,
          nextRevision: content === null ? null : digest(content),
          bytes: content === null ? 0 : Buffer.byteLength(content),
          operation,
          fieldClass: "content",
          surface: content === null ? "delete" : "workspace",
        });
      }
      prepared.push({ path, content, operation });
    };
    for (const op of operations) {
      if (op.type === "rmdir") {
        if (operations.length !== 1)
          throw new ToolError(
            "invalid_input",
            "Empty-directory removal must be a single operation.",
          );
        const directory = resolve(op.path);
        const target = locate(directory);
        if (target === undefined || (target.kind !== "authoring" && target.kind !== "operational"))
          throw new ToolError("denied", "Configuration directory is not admitted for removal.");
        const revision = captureEmptyDirectory(directory);
        directorySnapshots.set(directory, revision);
        facts.push({
          canonicalPath: directory,
          root: target.root,
          expectedRevision: revision,
          nextRevision: null,
          bytes: 0,
          operation: "delete",
          fieldClass: target.path.split("/")[0] ?? "directory",
          surface: /^skills(?:\/[a-z0-9][a-z0-9_-]*)?$/.test(target.path)
            ? "authoring_delete"
            : "delete",
        });
        prepared.push({ path: directory, content: null, operation: "delete" });
      } else if (op.type === "rename") {
        if (op.from === undefined)
          throw new ToolError("invalid_input", "Rename requires its captured source.");
        const source = captureInitial(op.from);
        if (source === null) throw new ToolError("not_found", "Rename source disappeared.");
        const content = op.content ?? source.toString("utf8");
        if (op.content === undefined && !Buffer.from(content).equals(source))
          throw new ToolError("invalid_input", "Configuration requires UTF-8 text.");
        add(op.from, null);
        add(op.path, content);
      } else {
        if (op.type !== "delete" && op.content === undefined)
          throw new ToolError("invalid_input", "Configuration requires prepared content.");
        add(
          op.path,
          op.type === "delete" ? null : op.content!,
          op.type === "delete" ? "delete" : (op.intent ?? "write"),
        );
      }
    }
    if (prepared.reduce((bytes, item) => bytes + Buffer.byteLength(item.content ?? ""), 0) > 262144)
      throw new ToolError("too_large", "Configuration batch exceeds the review payload limit.");
    const inclusion =
      inclusions.length === 0 ? undefined : options.prepareSkillInclusion(inclusions);
    const recordSessionGrant = await review(
      [...facts, ...(inclusion?.facts ?? [])],
      { operations: prepared, membership: inclusion?.review },
      `Review configuration batch:\n${prepared.map((item) => `${item.operation} ${item.path}\n${item.content ?? ""}`).join("\n\n")}\n${inclusion === undefined ? "" : JSON.stringify(inclusion.review, null, 2)}`,
    );
    const authority = ctx.services.get(OPERATOR_AUTHORITY_PORT);
    const admitted = authority?.snapshot();
    const assertAuthority = (): void => {
      const current = authority?.snapshot();
      if (admitted === undefined) return;
      if (
        current?.status !== "active" ||
        current.revision !== admitted.revision ||
        current.binding.owner_key_name !== admitted.binding.owner_key_name ||
        current.binding.session_id !== admitted.binding.session_id ||
        current.binding.controller_epoch !== admitted.binding.controller_epoch ||
        current.binding.outcome_id !== admitted.binding.outcome_id
      )
        throw new ToolError(
          "revision_conflict",
          "Configuration authority changed before commit. Prepare the batch again.",
        );
    };
    for (const [path, expected] of snapshots) {
      const current = capture(path);
      if ((current === null ? null : digest(current)) !== expected)
        throw new ToolError(
          "revision_conflict",
          "Configuration revision conflict. Prepare the batch again.",
        );
    }
    for (const [path, expected] of directorySnapshots) {
      let current: string;
      try {
        current = captureEmptyDirectory(path);
      } catch (error) {
        if (
          error instanceof ToolError &&
          (error.code === "invalid_input" || error.code === "not_found")
        )
          throw new ToolError("revision_conflict", "Directory changed during review.");
        throw error;
      }
      if (current !== expected)
        throw new ToolError("revision_conflict", "Directory changed during review.");
    }
    ctx.signal?.throwIfAborted();
    const checkedCommit = () => {
      ctx.signal?.throwIfAborted();
      assertAuthority();
      return commit();
    };
    const write = () =>
      inclusion === undefined ? checkedCommit() : inclusion.apply(checkedCommit);
    const workspaceFacts = facts.filter((fact) => {
      if (directorySnapshots.has(fact.canonicalPath)) return false;
      const rel = relative(ctx.workspaceRoot, fact.canonicalPath);
      return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
    });
    if (options.store.withOperatorWrite !== undefined && workspaceFacts.length > 0)
      await options.store.withOperatorWrite("workspace", write, () =>
        workspaceFacts.map((fact) => ({
          path: fact.canonicalPath,
          expectedRevision: fact.nextRevision,
        })),
      );
    else await write();
    for (const fact of facts) options.changed(fact.canonicalPath);
    recordSessionGrant?.();
  };
  return Object.assign(authoring, {
    async commitClassified(
      operations: Parameters<MutationReview>[0],
      policy: ResolvedFilesystemPolicy,
    ): Promise<void> {
      if (operations.some((op) => op.type === "rmtree"))
        throw new ToolError("denied", "Recursive cleanup cannot use the classified host commit.");
      if (policy.placement !== "sandbox")
        throw new ToolError("denied", "Classified host commit requires a native Sandbox policy.");
      for (const operation of operations) {
        for (const path of [
          operation.path,
          ...(operation.from === undefined ? [] : [operation.from]),
        ]) {
          if (!isAbsolute(path))
            throw new ToolError("invalid_input", "Classified host commit requires absolute paths.");
          const target = locate(path);
          if (target !== undefined && target.kind !== "authoring" && target.kind !== "operational")
            throw new ToolError(
              "denied",
              "Classified host commit cannot change protected configuration.",
            );
          if (target === undefined) {
            const local = relative(ctx.workspaceRoot, path);
            if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`))
              throw new ToolError(
                "denied",
                "Classified host commit requires a workspace batch target.",
              );
          }
          if (
            policy.workspaceAccess === "read-only" &&
            (target === undefined || target.root.startsWith("workspace_"))
          )
            throw new ToolError("denied", "Classified workspace batch is read-only.");
          if (
            policy.protectedRoots.some((root) => {
              const local = relative(root, path);
              return (
                local === "" ||
                (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`))
              );
            })
          )
            throw new ToolError("denied", "Classified host commit cannot change a protected path.");
          if (operation.type === "rmdir") captureEmptyDirectory(path);
          else capture(path);
        }
      }
      ctx.signal?.throwIfAborted();
      if (operations[0]?.type === "rmdir") {
        if (operations.length !== 1)
          throw new ToolError(
            "invalid_input",
            "Empty-directory removal must be a single operation.",
          );
        const directory = operations[0].path;
        try {
          rmdirSync(directory);
        } catch (error) {
          if (
            ["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")
          )
            throw new ToolError("revision_conflict", "Directory changed before commit.");
          throw error;
        }
        try {
          await fsyncDir(dirname(directory));
        } catch {
          throw new ToolError(
            "commit_partial",
            "Directory was removed but durability could not be confirmed.",
          );
        }
        return;
      }
      await applyOpsAtomic([...operations]);
    },
  });
}
