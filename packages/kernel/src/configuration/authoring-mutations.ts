import {
  OPERATOR_AUTHORITY_PORT,
  type RunCapabilityContext,
  type Logger,
} from "@clarvis/capability";
import { configurationTarget, type ConfigurationRoot } from "@clarvis/paths";
import type { ExtensionProfileSkillRef } from "@clarvis/protocol";
import { applyOpsAtomic, type MutationReview } from "@clarvis/tools";
import type { ResolvedFilesystemPolicy } from "@clarvis/tools/sandbox";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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
        if (stat.isSymbolicLink()) throw new Error("Configuration cannot traverse symbolic links.");
        if (parent === path && (stat.nlink > 1 || stat.size > 262144))
          throw new Error("Configuration requires a bounded, unaliased document.");
        if (parent === path && !stat.isFile())
          throw new Error("Configuration requires a regular file target.");
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
        throw new Error("Configuration file exceeds the review payload limit.");
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const authoring: MutationReview = async (operations, commit) => {
    const paths = operations.flatMap((op) => [
      op.path,
      ...(op.from === undefined ? [] : [op.from]),
    ]);
    if (!paths.some((path) => locate(resolve(path)) !== undefined)) return commit();
    if (operations.length > 128 || new Set(paths).size !== paths.length)
      throw new Error("Configuration batch is too large or changes a target more than once.");
    const facts: ConfigurationMutationFacts[] = [];
    const snapshots = new Map<string, string | null>();
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
        throw new Error("File-tool batch target is outside the admitted roots.");
      if (target?.kind === "private") throw new Error(`Configuration target is private: ${path}.`);
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
          throw new Error("Configuration batch file exceeds the review limit.");
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
      if (op.type === "rename") {
        if (op.from === undefined) throw new Error("Rename requires its captured source.");
        const source = captureInitial(op.from);
        if (source === null) throw new Error("Rename source disappeared.");
        const content = op.content ?? source.toString("utf8");
        if (op.content === undefined && !Buffer.from(content).equals(source))
          throw new Error("Configuration requires UTF-8 text.");
        add(op.from, null);
        add(op.path, content);
      } else {
        if (op.type !== "delete" && op.content === undefined)
          throw new Error("Configuration requires prepared content.");
        add(
          op.path,
          op.type === "delete" ? null : op.content!,
          op.type === "delete" ? "delete" : (op.intent ?? "write"),
        );
      }
    }
    if (prepared.reduce((bytes, item) => bytes + Buffer.byteLength(item.content ?? ""), 0) > 262144)
      throw new Error("Configuration batch exceeds the review payload limit.");
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
        throw new Error("Configuration authority changed before commit. Prepare the batch again.");
    };
    for (const [path, expected] of snapshots) {
      const current = capture(path);
      if ((current === null ? null : digest(current)) !== expected)
        throw new Error("Configuration revision conflict. Prepare the batch again.");
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
      if (policy.placement !== "sandbox")
        throw new Error("Classified host commit requires a native Sandbox policy.");
      for (const operation of operations) {
        for (const path of [
          operation.path,
          ...(operation.from === undefined ? [] : [operation.from]),
        ]) {
          if (!isAbsolute(path)) throw new Error("Classified host commit requires absolute paths.");
          const target = locate(path);
          if (target?.kind === "private")
            throw new Error("Classified host commit cannot change private configuration.");
          if (target === undefined) {
            const local = relative(ctx.workspaceRoot, path);
            if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`))
              throw new Error("Classified host commit requires a workspace batch target.");
          }
          if (
            policy.workspaceAccess === "read-only" &&
            (target === undefined || target.root.startsWith("workspace_"))
          )
            throw new Error("Classified workspace batch is read-only.");
          if (
            policy.protectedRoots.some((root) => {
              const local = relative(root, path);
              return (
                local === "" ||
                (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`))
              );
            })
          )
            throw new Error("Classified host commit cannot change a protected path.");
          capture(path);
        }
      }
      ctx.signal?.throwIfAborted();
      await applyOpsAtomic([...operations]);
    },
  });
}
