import type { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { killTree } from "./process.ts";
import type { ToolsLogger } from "./log.ts";

/** A live process whose child handle and process-group identity belong to one run. */
export interface OwnedProcess {
  readonly pid: number;
  readonly child: ChildProcess;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Stop only a child held in this process; a saved PID never grants authority. */
export async function stopOwnedProcess(
  processOwner: OwnedProcess,
  logger: ToolsLogger,
  deadline = Date.now() + 1_200,
): Promise<boolean> {
  if (!ownedTreeRunning(processOwner)) return true;
  signalOwnedTree(processOwner, "SIGTERM", logger);
  const graceEnd = Math.min(deadline, Date.now() + 400);
  while (ownedTreeRunning(processOwner) && Date.now() < graceEnd)
    await wait(Math.min(25, graceEnd - Date.now()));
  if (ownedTreeRunning(processOwner)) signalOwnedTree(processOwner, "SIGKILL", logger);
  while (ownedTreeRunning(processOwner) && Date.now() < deadline)
    await wait(Math.min(25, deadline - Date.now()));
  return !ownedTreeRunning(processOwner);
}
