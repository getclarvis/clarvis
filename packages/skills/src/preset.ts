import { homedir } from "node:os";
import { agentsSkillsDirs, globalPaths, resolveWorkspaceDir, workspacePaths } from "@clarvis/paths";
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
  /** Environment consulted for `CLARVIS_HOME`. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Build Clarvis's standard four skill roots in ascending precedence order (later
 * wins on same-name collisions during merge).
 *
 * The roots pair two sources — `agents` (`.agents/skills`) and `clarvis`
 * (`.clarvis/skills`) — across two scopes — `user` (under `home`) and
 * `workspace` (under the resolved workspace) — yielding user/agents,
 * workspace/agents, user/clarvis, workspace/clarvis.
 *
 * @param opts - path overrides; see {@link ClarvisSkillRootsOptions}.
 * @returns the four {@link SkillRootInput} roots, lowest precedence first.
 */
export function clarvisSkillRoots(opts: ClarvisSkillRootsOptions = {}): SkillRootInput[] {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const workspaceDir = resolveWorkspaceDir(opts.workspace, cwd, home);

  const env = opts.env ?? process.env;
  const agents = agentsSkillsDirs({ home, cwd: workspaceDir, env: {} });

  return [
    { path: agents.user, scope: "user", source: "agents" },
    { path: agents.workspace, scope: "workspace", source: "agents" },
    { path: globalPaths(undefined, { home, env }).skillsDir, scope: "user", source: "clarvis" },
    { path: workspacePaths(workspaceDir).skillsDir, scope: "workspace", source: "clarvis" },
  ];
}
