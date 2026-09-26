import type { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { killTree } from "./process.ts";
import type { ToolsLogger } from "./log.ts";

/** A live process whose child handle and process-group identity belong to one run. */
export interface OwnedProcess {
  readonly pid: number;
  readonly child: Pick<ChildProcess, "exitCode" | "signalCode">;
}

/** Effects used by the stop policy; production probes and signals the owned OS tree. */
export interface ProcessOwnerDeps {
  now(): number;
  wait(ms: number): Promise<void>;
  isRunning(owner: OwnedProcess): boolean;
  signal(owner: OwnedProcess, signal: NodeJS.Signals, logger: ToolsLogger): void;
}

/** Report whether a process ID still names a running process; Linux zombies count as exited. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
    }
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function rootRunning(processOwner: OwnedProcess): boolean {
  return (
    processOwner.child.exitCode === null &&
    processOwner.child.signalCode === null &&
    isAlive(processOwner.pid)
  );
}

export function ownedTreeRunning(processOwner: OwnedProcess): boolean {
  try {
    process.kill(-processOwner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  if (process.platform !== "linux") return true;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return true;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) !== processOwner.pid) continue;
      if (fields[0] !== "Z" && fields[0] !== "X") return true;
    } catch {
      continue;
    }
  }
  return false;
}

function signalOwnedTree(
  processOwner: OwnedProcess,
  signal: NodeJS.Signals,
  logger: ToolsLogger,
): void {
  const pid = processOwner.pid;
  try {
    process.kill(-pid, signal);
  } catch {
    if (rootRunning(processOwner)) killTree(pid, signal, { logger });
  }
}

const REAL_OWNER_DEPS: ProcessOwnerDeps = {
  now: Date.now,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  isRunning: ownedTreeRunning,
  signal: signalOwnedTree,
};

/** Stop only a child held in this process; a saved PID never grants authority. */
export async function stopOwnedProcess(
  processOwner: OwnedProcess,
  logger: ToolsLogger,
  deadline?: number,
  deps: ProcessOwnerDeps = REAL_OWNER_DEPS,
): Promise<boolean> {
  const stopDeadline = deadline ?? deps.now() + 1_200;
  if (!deps.isRunning(processOwner)) return true;
  deps.signal(processOwner, "SIGTERM", logger);
  const graceEnd = Math.min(stopDeadline, deps.now() + 400);
  while (deps.isRunning(processOwner) && deps.now() < graceEnd)
    await deps.wait(Math.min(25, graceEnd - deps.now()));
  if (deps.isRunning(processOwner)) deps.signal(processOwner, "SIGKILL", logger);
  while (deps.isRunning(processOwner) && deps.now() < stopDeadline)
    await deps.wait(Math.min(25, stopDeadline - deps.now()));
  return !deps.isRunning(processOwner);
}
