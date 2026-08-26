import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { DIR_MODE, FILE_MODE } from "./constants.ts";
import { writeFileAtomicSync } from "./atomic.ts";
import { pathsLogger } from "./diag.ts";
import { workspacePaths } from "./workspace.ts";

/**
 * Content seeded into `<ws>/.clarvis/.gitignore`.
 *
 * @remarks
 * Selective rather than a blanket `*`: `settings.json`, `agents/`, `skills/`,
 * `workflows/`, `plugins/`, `guard-judge.md` and `memory-policy.md` are a workspace's own
 * configuration and belong in its history. What is listed here is generated
 * Markdown a repository should opt into versioning deliberately, plus Git-owned
 * worktree checkouts that must never be staged accidentally. `owners/` holds the
 * per-owner copies of `plans/` and `memory/`, so it belongs for the same reason they do.
 *
 * There is no `local/` entry any more, because there is no `local/`: every
 * machine-local byte moved under the global root, reachable only through
 * `workspaceStatePaths`.
 *
 * **It ignores itself**, so a workspace Clarvis has run in reports a clean
 * `git status` rather than one untracked file. That is sound because this
 * content is not the user's configuration: it is Clarvis's own rule, a constant
 * in this module, and {@link ensureWorkspaceDir} re-seeds it on every machine
 * the moment anything is written. Committing it instead would put a file in
 * someone's history that a Clarvis version bump can change underneath them, to
 * protect directories that only ever appear once Clarvis has run — which is
 * exactly when the file is created. A user who does want it versioned can still
 * `git add -f` it, and a hand-edited copy survives regardless. Existing hand-edited
 * files retain their bytes and gain `worktrees/` only when that mandatory safety
 * rule is absent.
 */
export const WORKSPACE_GITIGNORE = ".gitignore\nplans/\nmemory/\nowners/\nworktrees/\n";

/**
 * Create a directory owner-only, tolerating a platform that ignores the mode.
 *
 * @param dir - the absolute directory to create.
 */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

/**
 * Seed a file only if absent, leaving a hand-edited one untouched.
 *
 * @param file - the absolute file to create.
 * @param content - the content to write on creation.
 *
 * @remarks
 * Exclusive-create is what makes repeated calls idempotent *and* keeps a user's
 * edits. Determinism comes from every entry point calling the ensure function,
 * not from overwriting what it finds.
 */
function seedFile(file: string, content: string): void {
  try {
    writeFileSync(file, content, { flag: "wx", mode: FILE_MODE });
  } catch (error) {
    pathsLogger().debug(
      {
        event: "paths.gitignore_seed_skipped",
        file,
        code: (error as NodeJS.ErrnoException | null)?.code ?? "unknown",
      },
      "the workspace ignore file was not seeded; only EEXIST means it was already there",
    );
    if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") return;
    try {
      const current = readFileSync(file, "utf8");
      if (current.split(/\r?\n/).includes("worktrees/")) return;
      const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
      writeFileAtomicSync(file, `${current}${separator}worktrees/\n`);
    } catch (updateError) {
      pathsLogger().warn(
        {
          event: "paths.gitignore_update_failed",
          file,
          code: (updateError as NodeJS.ErrnoException | null)?.code ?? "unknown",
        },
        "the workspace ignore file could not be updated with the worktree exclusion",
      );
      throw updateError;
    }
  }
}

/**
 * Ensure a workspace's `.clarvis` directory exists and carries its `.gitignore`.
 *
 * @param root - the working tree root.
 * @returns the absolute `.clarvis` directory.
 *
 * @remarks
 * Every entry point that is about to write anything under `.clarvis` calls this
 * first. That is the whole mechanism: the ignore file used to be seeded by
 * whichever tool happened to run first, so whether it existed at all depended on
 * the order of events rather than on any decision.
 */
export function ensureWorkspaceDir(root: string): string {
  const dir = workspacePaths(root).clarvisDir;
  ensureDir(dir);
  seedFile(join(dir, ".gitignore"), WORKSPACE_GITIGNORE);
  return dir;
}

/**
 * Ensure a workspace subdirectory exists beneath a seeded `.clarvis`.
 *
 * @param dir - an absolute directory that is inside `<root>/.clarvis`.
 * @param root - the working tree root.
 * @returns the absolute directory.
 *
 * @remarks
 * The entry point for the two generated Markdown trees, `plans/` and `memory/`.
 * Both used to `mkdir` their own root, which meant the workspace `.gitignore`
 * was seeded only if some *other* writer happened to run first — so whether a
 * repository showed `?? .clarvis/` depended on the order of events rather than
 * on any decision. That is the exact failure {@link ensureWorkspaceDir} was
 * introduced to remove, reappearing one directory down.
 */
export function ensureWorkspaceSubdir(dir: string, root: string): string {
  const clarvisDir = workspacePaths(root).clarvisDir;
  const target = resolve(dir);
  const fromClarvis = relative(clarvisDir, target);
  if (
    fromClarvis === "" ||
    fromClarvis === ".." ||
    fromClarvis.startsWith(`..${sep}`) ||
    isAbsolute(fromClarvis)
  ) {
    throw new Error(`workspace subdirectory must be inside '${clarvisDir}': '${target}'`);
  }
  ensureWorkspaceDir(root);
  ensureDir(target);
  return target;
}
