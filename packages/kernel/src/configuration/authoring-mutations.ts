import type { RunCapabilityContext, Logger } from "@clarvis/capability";
import { configurationTarget, type ConfigurationRoot } from "@clarvis/paths";
import type { ExtensionProfileSkillRef } from "@clarvis/protocol";
import type { MutationReview } from "@clarvis/tools";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ConfigStore } from "../config/config-store.ts";
import type { PreparedSkillInclusion } from "../extension-profiles/extension-profile-manager.ts";
import type { ConfigurationMutationFacts } from "../guard/effects/configuration.ts";
import { configurationFileMutationFacts, configurationSkillRef } from "./files.ts";
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
    let parent = path;
    while (true) {
      try {
        const stat = lstatSync(parent);
        if (stat.isSymbolicLink()) throw new Error("Authoring cannot traverse symbolic links.");
        if (parent === path && (stat.nlink > 1 || stat.size > 262144))
          throw new Error("Authoring requires a bounded, unaliased document.");
        if (parent === path && !stat.isFile())
          throw new Error("Authoring requires a regular file target.");
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
        throw new Error("Authoring file exceeds the review payload limit.");
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  return async (operations, commit) => {
    const paths = operations.flatMap((op) => [
      op.path,
      ...(op.from === undefined ? [] : [op.from]),
    ]);
    if (
      !paths.some((path) => {
        const target = locate(resolve(path));
        return target !== undefined && target.kind === "authoring";
      })
    )
      return commit();
    if (operations.length > 128 || new Set(paths).size !== paths.length)
      throw new Error("Authoring batch is too large or changes a target more than once.");
    const facts: ConfigurationMutationFacts[] = [];
    const snapshots = new Map<string, string | null>();
    const inclusions: ExtensionProfileSkillRef[] = [];
    const prepared: { path: string; content: string | null }[] = [];
    const add = (path: string, content: string | null): void => {
      path = resolve(path);
      const local = relative(ctx.workspaceRoot, path);
      if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`))
        throw new Error("File-tool authoring must remain inside the admitted workspace.");
      const before = capture(path);
      const expected = before === null ? null : digest(before);
      snapshots.set(path, expected);
      const target = locate(path);
      if (target !== undefined) {
        if (target.kind !== "authoring")
          throw new Error(
            "Operational configuration requires configure_clarvis; private state cannot be authored.",
          );
        const fact = configurationFileMutationFacts(options.roots, {
          ...target,
          operation: content === null ? "delete" : "write",
          ...(content === null ? {} : { content }),
          expected_revision: expected,
        });
        if (fact === undefined) throw new Error("Missing prepared authoring effect.");
        facts.push(fact);
        if (expected === null && content !== null) {
          const ref = configurationSkillRef(options.roots, target.root, target.path, content);
          if (ref !== undefined) inclusions.push(ref);
        }
      } else {
        if (content !== null && Buffer.byteLength(content) > 262144)
          throw new Error("Authoring batch file exceeds the review limit.");
        facts.push({
          canonicalPath: path,
          root: "workspace",
          expectedRevision: expected,
          nextRevision: content === null ? null : digest(content),
          bytes: content === null ? 0 : Buffer.byteLength(content),
          operation: content === null ? "delete" : "write",
          fieldClass: "content",
          surface: content === null ? "delete" : "workspace",
        });
      }
      prepared.push({ path, content });
    };
    for (const op of operations) {
      if (op.type === "rename") {
        if (op.from === undefined) throw new Error("Rename requires its captured source.");
        const source = capture(op.from);
        if (source === null) throw new Error("Rename source disappeared.");
        const content = op.content ?? source.toString("utf8");
        if (op.content === undefined && !Buffer.from(content).equals(source))
          throw new Error("Authoring requires UTF-8 text.");
        add(op.from, null);
        add(op.path, content);
      } else {
        if (op.type !== "delete" && op.content === undefined)
          throw new Error("Authoring requires prepared content.");
        add(op.path, op.type === "delete" ? null : op.content!);
      }
    }
    if (prepared.reduce((bytes, item) => bytes + Buffer.byteLength(item.content ?? ""), 0) > 262144)
      throw new Error("Authoring batch exceeds the review payload limit.");
    const inclusion =
      inclusions.length === 0 ? undefined : options.prepareSkillInclusion(inclusions);
    await review(
      [...facts, ...(inclusion?.facts ?? [])],
      { operations: prepared, membership: inclusion?.review },
      `Review authoring batch:\n${prepared.map((item) => `${item.content === null ? "Delete" : "Write"} ${item.path}\n${item.content ?? ""}`).join("\n\n")}\n${inclusion === undefined ? "" : JSON.stringify(inclusion.review, null, 2)}`,
    );
    for (const [path, expected] of snapshots) {
      const current = capture(path);
      if ((current === null ? null : digest(current)) !== expected)
        throw new Error("Authoring revision conflict. Prepare the batch again.");
    }
    ctx.signal?.throwIfAborted();
    const write = () => (inclusion === undefined ? commit() : inclusion.apply(commit));
    if (options.store.withOperatorWrite !== undefined)
      await options.store.withOperatorWrite("workspace", write, () =>
        facts.map((fact) => ({ path: fact.canonicalPath, expectedRevision: fact.nextRevision })),
      );
    else await write();
    for (const fact of facts) options.changed(fact.canonicalPath);
  };
}
