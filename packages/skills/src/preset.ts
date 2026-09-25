import { homedir } from "node:os";
import { agentsSkillsDirs, resolveWorkspaceDir } from "@clarvis/paths";
import type { SkillRootInput } from "./types.ts";

/**
 * Options for {@link clarvisSkillRoots}; each field is injectable for testing and
 * defaults to the ambient value.
 */
export interface ClarvisSkillRootsOptions {
  /** Workspace path (relative/absolute/`~`); resolved against `cwd`. Defaults to `cwd`. */
  workspace?: string;
  /** Current working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Home directory for `~` expansion and the user-scoped roots. Defaults to `os.homedir()`. */
  home?: string;
  /** Reserved environment override for callers using the shared roots. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Build Clarvis's two shared skill roots in ascending precedence order (later
 * wins on same-name collisions during merge).
 *
 * User skills precede workspace skills with the same name.
 *
 * @param opts - path overrides; see {@link ClarvisSkillRootsOptions}.
 * @returns the two {@link SkillRootInput} roots, lowest precedence first.
 */
export function clarvisSkillRoots(opts: ClarvisSkillRootsOptions = {}): SkillRootInput[] {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const workspaceDir = resolveWorkspaceDir(opts.workspace, cwd, home);

  const agents = agentsSkillsDirs({ home, cwd: workspaceDir, env: {} });

  return [
    { path: agents.user, scope: "user", source: "agents" },
    { path: agents.workspace, scope: "workspace", source: "agents" },
  ];
}
