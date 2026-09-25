import { spawn } from "node:child_process";
import { lstat, rm } from "node:fs/promises";
import { constants } from "node:os";
import { join } from "node:path";
import { readCiWorkspaces, requireCiDirectory, type CiWorkspace } from "./ci-workspaces.ts";

export interface CoverageCommand {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

export interface CoverageExit {
  code: number;
  signal: NodeJS.Signals | null;
}

export interface CoverageEvent {
  package: string;
  attempt: number;
  phase: "start" | "end" | "retry";
  at: number;
  durationMs?: number;
  result?: CoverageExit;
}

export interface CoverageDependencies {
  execute: (command: CoverageCommand) => Promise<CoverageExit>;
  now: () => number;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
  emit: (event: CoverageEvent) => void;
  bun: string;
}

const CRASH_EXITS = new Set([132, 134, 139]);
const MAX_CODE_RETRIES = 3;

/** Bun can re-raise a script's signal with a null exit code; unknown termination fails closed. */
export function normalizeCoverageExit(
  code: number | null,
  signal: NodeJS.Signals | null,
): CoverageExit {
  return { code: signal ? 128 + (constants.signals[signal] ?? 1) : (code ?? 1), signal };
}

/**
 * Run argv with inherited logs and wait for physical child closure. Cancellation terminates the
 * POSIX process group, including Bun's script shell, with a bounded kill fuse for uncooperative children.
 */
export async function executeCoverageCommand(command: CoverageCommand): Promise<CoverageExit> {
  command.signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn(command.argv[0], command.argv.slice(1), {
      cwd: command.cwd,
      env: command.env,
      stdio: "inherit",
      detached: true,
    });
    let killFuse: ReturnType<typeof setTimeout> | undefined;
    let killError: Error | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          killError = new Error("Failed to terminate CI child", { cause: error });
      }
    };
    const cancel = () => {
      kill("SIGTERM");
      killFuse ??= setTimeout(() => kill("SIGKILL"), 5_000);
    };
    const cleanup = () => {
      clearTimeout(killFuse);
      command.signal.removeEventListener("abort", cancel);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (command.signal.aborted) kill("SIGKILL");
      cleanup();
      if (killError) reject(killError);
      else resolve(normalizeCoverageExit(code, signal));
    });
    command.signal.addEventListener("abort", cancel, { once: true });
    if (command.signal.aborted) cancel();
  });
}

/** Delete only this package's old LCOV, after rechecking the directory boundary for every attempt. */
async function clearReport(root: string, workspace: CiWorkspace): Promise<void> {
  await requireCiDirectory(root, workspace.relative);
  const coverage = join(workspace.directory, "coverage");
  try {
    if (!(await lstat(coverage)).isDirectory())
      throw new Error(`${workspace.name}: coverage must be a real directory`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(join(coverage, "lcov.info"), { force: true });
}

/**
 * Execute each complete workspace script sequentially. Only code's classified signal exits get
 * three additional attempts; the global checker runs only after every package, including protocol.
 * Importing this library starts no processes and owns no ambient signal handlers.
 */
export async function runCiCoverage(
  root: string,
  deps: CoverageDependencies,
): Promise<CoverageExit> {
  const workspaces = await readCiWorkspaces(root, "test:coverage");
  const run = async (name: string, cwd: string, script: string, attempt: number) => {
    deps.signal.throwIfAborted();
    const start = deps.now();
    deps.emit({ package: name, attempt, phase: "start", at: start });
    deps.signal.throwIfAborted();
    const result = await deps.execute({
      argv: [deps.bun, "run", script],
      cwd,
      env: deps.env,
      signal: deps.signal,
    });
    const end = deps.now();
    deps.emit({ package: name, attempt, phase: "end", at: end, durationMs: end - start, result });
    deps.signal.throwIfAborted();
    return result;
  };
  for (const workspace of workspaces) {
    for (let attempt = 1; ; attempt += 1) {
      deps.signal.throwIfAborted();
      await clearReport(root, workspace);
      const result = await run(workspace.name, workspace.directory, "test:coverage", attempt);
      if (result.code === 0) break;
      if (
        workspace.name !== "@clarvis/code" ||
        !CRASH_EXITS.has(result.code) ||
        attempt > MAX_CODE_RETRIES
      )
        return result;
      deps.emit({
        package: workspace.name,
        attempt: attempt + 1,
        phase: "retry",
        at: deps.now(),
        result,
      });
    }
  }
  return await run("coverage:check", root, "coverage:check", 1);
}
