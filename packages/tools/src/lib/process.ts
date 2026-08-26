import { spawnSync } from "node:child_process";
import { NOOP_TOOLS_LOGGER, type ToolsLogger } from "./log.ts";

/**
 * Runs `taskkill`. Injectable so the Windows argv is assertable from a POSIX
 * host, where the binary does not exist.
 */
export type TaskkillRunner = (file: string, args: string[]) => { status: number | null };

/** Injectable seams for {@link killTree}. */
export interface KillDeps {
  taskkill?: TaskkillRunner;
  platform?: NodeJS.Platform;
  /**
   * Where a wholly failed kill is reported; defaults to
   * {@link NOOP_TOOLS_LOGGER}.
   *
   * @remarks Every caller ignores {@link killTree}'s `false`, so without this a
   *   tree that outlived its kill is completely silent.
   */
  logger?: ToolsLogger;
}

/**
 * Whether a spawned child should be put in its own process group, i.e. what to
 * pass as `spawn`'s `detached` option.
 *
 * @param platform - host platform; injectable so the Windows branch is
 *   assertable from a POSIX host.
 * @returns `true` on POSIX, `false` on Windows.
 * @remarks
 * On POSIX the group is load-bearing: it is what lets {@link killTree} address
 * a whole tree as `-pid`, so a command's grandchildren die with it.
 *
 * Windows has no process groups, and `detached` there does not approximate one -
 * Node maps it to `DETACHED_PROCESS`, which denies the child a console. A
 * console-subsystem shell spawned that way produces nothing at all: empty
 * stdout and stderr, a `null` exit code, and - for a monitor, which writes to an
 * inherited file descriptor rather than a pipe - an empty log and no exit
 * sidecar, while the spawn itself still reports success.
 *
 * Nothing on Windows needs the flag. {@link killTree} walks the parent-pid tree
 * with `taskkill /T` rather than addressing a group, and a Windows child already
 * outlives its parent, so a backgrounded monitor survives on `unref` alone.
 */
export function ownProcessGroup(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

function runTaskkill(file: string, args: string[]): { status: number | null } {
  const result = spawnSync(file, args, { stdio: "ignore", windowsHide: true });
  return { status: result.error ? null : result.status };
}

/**
 * Terminate a process and everything it spawned.
 *
 * @param pid - the root process; its descendants go with it.
 * @param signal - the POSIX signal to send. Ignored on Windows, which has no
 *   signals: `taskkill /F` is a `TerminateProcess`, so `SIGTERM` and `SIGKILL`
 *   are the same abrupt kill there and a graceful-shutdown handler never runs.
 * @param deps - test seams.
 * @returns `true` if anything was signalled, `false` if every attempt failed -
 *   typically because the process is already gone.
 * @remarks
 * POSIX addresses the process group as `-pid`, falling back to the lone pid when
 * the group is already gone (a child that called `setsid`). Windows has no
 * process groups, so `taskkill /T` walks the parent-pid tree instead. Both have
 * the same hole from opposite directions: a descendant whose intermediate parent
 * has already exited is re-parented and escapes the walk, exactly as `setsid`
 * detaches a child from its group on POSIX. Closing it on Windows would take a
 * Job Object, which is deliberately out of scope.
 *
 * `spawnSync` blocks the event loop for the `taskkill` round trip. Both call
 * sites are already on a timeout or teardown path, and a synchronous boolean is
 * what the callers' injectable-dependency contracts expect.
 */
export function killTree(pid: number, signal: NodeJS.Signals, deps: KillDeps = {}): boolean {
  const platform = deps.platform ?? process.platform;
  const logger = deps.logger ?? NOOP_TOOLS_LOGGER;
  const failed = (): false => {
    logger.warn(
      { event: "tools.kill_tree_failed", pid, signal, platform },
      "nothing could be signalled for this process tree; it is either already gone or still running unreachable",
    );
    return false;
  };
  if (platform === "win32") {
    const taskkill = deps.taskkill ?? runTaskkill;
    if (taskkill("taskkill", ["/pid", String(pid), "/T", "/F"]).status === 0) return true;
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return failed();
    }
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return failed();
    }
  }
}
