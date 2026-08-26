import { homedir } from "node:os";
import path from "node:path";
import { resolvePath } from "../lib/paths.ts";
import type { PathFact } from "./types.ts";

/**
 * Expand a leading `~` or `~/` to the current user's home directory; leave
 * `~user` and everything else untouched.
 *
 * @param p - the raw token.
 * @param platform - host platform; injectable for tests.
 * @remarks
 * On Windows `~\` must expand too. Left unhandled it does not stay literal - it
 * falls through and resolves as a path *relative to the workspace*, so a command
 * reading `~\.ssh\id_rsa` would be reported as staying inside the workspace. The
 * `~\` arm stays platform-gated because POSIX `sh` genuinely does not expand it.
 *
 * `path.join` rather than concatenation, so the result carries one consistent
 * separator instead of whatever mix the two halves happened to use.
 */
function expandTilde(p: string, platform: NodeJS.Platform = process.platform): string {
  if (p === "~") return homedir();
  const windows = platform === "win32";
  if (p.startsWith("~/") || (windows && p.startsWith("~\\"))) {
    return path.join(homedir(), p.slice(2));
  }
  return p;
}

/**
 * Turn one raw path token into a {@link PathFact}: its absolute `resolved` form
 * and whether it stays within the workspace.
 *
 * @param raw - the path token as the caller wrote it (kept verbatim in the
 *   result's `raw`).
 * @param workspaceRoot - the workspace root that confinement is measured against.
 * @param opts - `shell: true` first expands a leading `~`/`~/`, for tokens that
 *   came from a shell command line.
 * @returns a {@link PathFact} carrying `raw`, the `resolved` absolute path, and
 *   `withinWorkspace`.
 * @remarks
 * `withinWorkspace` is derived by re-running {@link resolvePath} in confining
 * mode and catching its throw, so a symlink or `..` escaping the root reports
 * `false` rather than raising here.
 */
export function resolveCandidate(
  raw: string,
  workspaceRoot: string,
  opts: { shell?: boolean; alsoAllow?: readonly string[] } = {},
): PathFact {
  const input = opts.shell ? expandTilde(raw) : raw;
  const resolved = resolvePath(input, workspaceRoot);
  let withinWorkspace = true;
  try {
    resolvePath(input, workspaceRoot, true, opts.alsoAllow);
  } catch {
    withinWorkspace = false;
  }
  return { raw, resolved, withinWorkspace };
}

/**
 * Extract the path from a unified-diff header value: drop a trailing tab-suffix
 * (timestamp), trim, preserve `/dev/null`, and strip a leading `a/` or `b/`
 * git prefix. Returns `undefined` for an empty name.
 */
function cleanName(raw: string): string | undefined {
  const noTab = raw.split("\t")[0] ?? raw;
  const trimmed = noTab.trim();
  if (trimmed === "") return undefined;
  if (trimmed === "/dev/null") return "/dev/null";
  return trimmed.replace(/^[ab]\//, "");
}

/**
 * Collect the distinct file paths a unified diff or model-friendly patch
 * envelope references from its file-operation headers.
 *
 * @param patch - the patch text to scan.
 * @returns the deduplicated path names in first-seen order, with `/dev/null`
 *   and git `a/`/`b/` prefixes handled by {@link cleanName}.
 * @remarks `/dev/null` sentinels (add/delete markers) are dropped, so the
 *   result holds only real workspace paths for the guard to resolve.
 */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of patch.split("\n")) {
    let raw: string | undefined;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) raw = line.slice(4);
    else {
      const modelHeader = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line);
      const moveHeader = /^\*\*\* Move to: (.+)$/.exec(line);
      raw = modelHeader?.[1] ?? moveHeader?.[1];
    }
    if (raw === undefined) continue;
    const name = cleanName(raw);
    if (name === undefined || name === "/dev/null" || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
