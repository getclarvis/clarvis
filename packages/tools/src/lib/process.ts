import { NOOP_TOOLS_LOGGER, type ToolsLogger } from "./log.ts";

/** Injectable diagnostic sink for process-tree termination. */
export interface KillDeps {
  logger?: ToolsLogger;
}

/** Put a spawned child in its own POSIX process group. */
export function ownProcessGroup(): boolean {
  return true;
}

/** Terminate a process group, falling back to its root process. */
export function killTree(pid: number, signal: NodeJS.Signals, deps: KillDeps = {}): boolean {
  const logger = deps.logger ?? NOOP_TOOLS_LOGGER;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      logger.warn(
        { event: "tools.kill_tree_failed", pid, signal, platform: process.platform },
        "nothing could be signalled for this process tree; it is either already gone or still running unreachable",
      );
      return false;
    }
  }
}
