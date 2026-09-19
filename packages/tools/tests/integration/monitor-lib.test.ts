import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, statSync, utimesSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
  monitorDir,
  sidecarPath,
  logPath,
  exitPath,
  mintId,
  ensureClarvisDir,
  isAlive,
  writeSidecar,
  readSidecar,
  listSidecars,
  readExitCode,
  readExitState,
  monitorRunning,
  removeMonitorFiles,
  sweepMonitors,
  MAX_MONITOR_EXIT_BYTES,
  MAX_MONITOR_SIDECAR_BYTES,
  type MonitorMeta,
} from "../../src/lib/monitor.ts";
import { ToolError } from "../../src/errors.ts";
import { fixtureStatePaths, makeWorkspace, cleanup } from "../helpers/fixtures.ts";
import { executableOnPath, workspacePaths } from "@clarvis/paths";
import type { WorkspaceStatePaths } from "@clarvis/paths";

const DEAD_PID = 2_147_480_000;
const mkfifo = process.platform === "win32" ? undefined : executableOnPath("mkfifo");

describe("monitor lib", () => {
  let root: string;
  let statePaths: WorkspaceStatePaths;

  beforeEach(() => {
    root = makeWorkspace();
    statePaths = fixtureStatePaths(root);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup(root);
  });

  function meta(id: string, pid: number): MonitorMeta {
    return { id, command: "cmd", cwd: root, pid, startedAt: 1, readyWhen: null };
  }
  function putRaw(name: string, content: string): void {
    mkdirSync(monitorDir(statePaths), { recursive: true });
    writeFileSync(path.join(monitorDir(statePaths), name), content);
  }

  it("builds sidecar/log/exit paths under the machine-local scratch dir", () => {
    const local = statePaths.localDir;
    expect(sidecarPath(statePaths, "mon_x")).toBe(path.join(local, "monitor-mon_x.json"));
    expect(logPath(statePaths, "mon_x")).toBe(path.join(local, "monitor-mon_x.log"));
    expect(exitPath(statePaths, "mon_x")).toBe(path.join(local, "monitor-mon_x.exit"));
  });

  it("puts none of a monitor's three files inside the working tree", () => {
    for (const built of [
      sidecarPath(statePaths, "m"),
      logPath(statePaths, "m"),
      exitPath(statePaths, "m"),
    ]) {
      expect(path.relative(workspacePaths(root).root, built)).toMatch(/^\.\.(?:[\\/]|$)/);
    }
  });

  it("mints ids of the form mon_<8 hex>", () => {
    expect(mintId()).toMatch(/^mon_[0-9a-f]{8}$/);
    expect(mintId()).not.toBe(mintId());
  });

  it("creates the scratch dir outside the working tree, idempotently", async () => {
    const first = await ensureClarvisDir(statePaths);
    expect(await ensureClarvisDir(statePaths)).toBe(first);
    expect(first).toBe(statePaths.localDir);
    expect(statSync(first).isDirectory()).toBe(true);
    expect(existsSync(workspacePaths(root).clarvisDir)).toBe(false);
  });

  it("isAlive reports the current process alive and a bogus pid dead", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(DEAD_PID)).toBe(false);
  });

  it("isAlive treats EPERM as alive", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const e = new Error("eperm") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    });
    expect(isAlive(1234)).toBe(true);
  });

  it("isAlive treats ESRCH as dead", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const e = new Error("esrch") as NodeJS.ErrnoException;
      e.code = "ESRCH";
      throw e;
    });
    expect(isAlive(1234)).toBe(false);
  });

  it("writes and reads back a sidecar", async () => {
    await writeSidecar(statePaths, meta("mon_aa", 111));
    const back = await readSidecar(statePaths, "mon_aa");
    expect(back.pid).toBe(111);
    expect(back.id).toBe("mon_aa");
  });

  it("readSidecar throws monitor_not_found for a missing, corrupt, or malformed sidecar", async () => {
    expect(readSidecar(statePaths, "mon_missing")).rejects.toMatchObject({
      code: "monitor_not_found",
    });
    putRaw("monitor-mon_bad.json", "{not json");
    expect(readSidecar(statePaths, "mon_bad")).rejects.toBeInstanceOf(ToolError);
    putRaw("monitor-mon_shape.json", JSON.stringify({ id: "mon_shape" }));
    expect(readSidecar(statePaths, "mon_shape")).rejects.toMatchObject({
      code: "monitor_not_found",
    });
  });

  it("rejects oversized sidecars and excludes them from enumeration", async () => {
    putRaw("monitor-mon_large.json", "x".repeat(MAX_MONITOR_SIDECAR_BYTES + 1));
    expect(readSidecar(statePaths, "mon_large")).rejects.toMatchObject({
      code: "monitor_not_found",
    });
    expect(await listSidecars(statePaths)).toEqual([]);
  });

  it.skipIf(mkfifo === undefined)(
    "rejects sidecar FIFOs without waiting for a writer",
    async () => {
      mkdirSync(monitorDir(statePaths), { recursive: true });
      const fifo = sidecarPath(statePaths, "mon_fifo");
      expect(spawnSync(mkfifo!, [fifo], { stdio: "ignore" }).status).toBe(0);
      expect(readSidecar(statePaths, "mon_fifo")).rejects.toMatchObject({
        code: "monitor_not_found",
      });
      expect(await listSidecars(statePaths)).toEqual([]);
    },
  );

  it("listSidecars returns [] with no dir and skips non-monitor and corrupt files", async () => {
    expect(await listSidecars(statePaths)).toEqual([]);
    await writeSidecar(statePaths, meta("mon_ok", 222));
    putRaw("monitor-mon_corrupt.json", "nope");
    putRaw("monitor-mon_x.txt", JSON.stringify(meta("mon_x", 1)));
    putRaw("other.json", JSON.stringify(meta("other", 1)));
    const list = await listSidecars(statePaths);
    expect(list.map((m) => m.id)).toEqual(["mon_ok"]);
  });

  it("readExitCode parses a valid code and yields null otherwise", async () => {
    mkdirSync(monitorDir(statePaths), { recursive: true });
    expect(await readExitCode(statePaths, "mon_none")).toBe(null);
    writeFileSync(exitPath(statePaths, "mon_zero"), "0");
    expect(await readExitCode(statePaths, "mon_zero")).toBe(0);
    writeFileSync(exitPath(statePaths, "mon_n"), "137\n");
    expect(await readExitCode(statePaths, "mon_n")).toBe(137);
    writeFileSync(exitPath(statePaths, "mon_bad"), "oops");
    expect(await readExitCode(statePaths, "mon_bad")).toBe(null);
    writeFileSync(exitPath(statePaths, "mon_huge"), "99999999999999999999");
    expect(await readExitCode(statePaths, "mon_huge")).toBe(null);
  });

  it("readExitState reports presence of the sentinel alongside the parsed code", async () => {
    mkdirSync(monitorDir(statePaths), { recursive: true });
    expect(await readExitState(statePaths, "mon_none")).toEqual({ exited: false, code: null });
    writeFileSync(exitPath(statePaths, "mon_zero"), "0");
    expect(await readExitState(statePaths, "mon_zero")).toEqual({ exited: true, code: 0 });
    writeFileSync(exitPath(statePaths, "mon_bad"), "oops");
    expect(await readExitState(statePaths, "mon_bad")).toEqual({ exited: true, code: null });
  });

  it("treats an oversized exit sentinel as present but invalid", async () => {
    mkdirSync(monitorDir(statePaths), { recursive: true });
    writeFileSync(exitPath(statePaths, "mon_large"), "1".repeat(MAX_MONITOR_EXIT_BYTES + 1));
    expect(await readExitState(statePaths, "mon_large")).toEqual({ exited: true, code: null });
  });

  it.skipIf(mkfifo === undefined)("does not wait for a writer on an exit FIFO", async () => {
    mkdirSync(monitorDir(statePaths), { recursive: true });
    const fifo = exitPath(statePaths, "mon_fifo");
    expect(spawnSync(mkfifo!, [fifo], { stdio: "ignore" }).status).toBe(0);
    expect(await readExitState(statePaths, "mon_fifo")).toEqual({ exited: true, code: null });
  });

  it("monitorRunning trusts the exit sentinel over a live (reused) pid", async () => {
    await writeSidecar(statePaths, meta("mon_run", process.pid));
    expect(await monitorRunning(statePaths, meta("mon_run", process.pid))).toBe(true);
    writeFileSync(exitPath(statePaths, "mon_run"), "0");
    expect(await monitorRunning(statePaths, meta("mon_run", process.pid))).toBe(false);
    expect(await monitorRunning(statePaths, meta("mon_dead", DEAD_PID))).toBe(false);
  });

  it("sweepMonitors reaps a naturally-exited monitor even when its pid was reused", async () => {
    await writeSidecar(statePaths, meta("mon_reused", process.pid));
    writeFileSync(logPath(statePaths, "mon_reused"), "x");
    writeFileSync(exitPath(statePaths, "mon_reused"), "0");
    const staleTime = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(exitPath(statePaths, "mon_reused"), staleTime, staleTime);
    await sweepMonitors(statePaths);
    expect(existsSync(sidecarPath(statePaths, "mon_reused"))).toBe(false);
    expect(existsSync(exitPath(statePaths, "mon_reused"))).toBe(false);
  });

  it("sweepMonitors preserves a monitor that exited within the age cutoff", async () => {
    await writeSidecar(statePaths, meta("mon_fresh", process.pid));
    writeFileSync(logPath(statePaths, "mon_fresh"), "x");
    writeFileSync(exitPath(statePaths, "mon_fresh"), "0");
    await sweepMonitors(statePaths);
    expect(existsSync(sidecarPath(statePaths, "mon_fresh"))).toBe(true);
    expect(existsSync(logPath(statePaths, "mon_fresh"))).toBe(true);
    expect(existsSync(exitPath(statePaths, "mon_fresh"))).toBe(true);
  });

  it("removeMonitorFiles deletes all three sidecars", async () => {
    await writeSidecar(statePaths, meta("mon_rm", 1));
    writeFileSync(logPath(statePaths, "mon_rm"), "log");
    writeFileSync(exitPath(statePaths, "mon_rm"), "0");
    await removeMonitorFiles(statePaths, "mon_rm");
    expect(existsSync(sidecarPath(statePaths, "mon_rm"))).toBe(false);
    expect(existsSync(logPath(statePaths, "mon_rm"))).toBe(false);
    expect(existsSync(exitPath(statePaths, "mon_rm"))).toBe(false);
  });

  it("sweepMonitors removes dead monitors and keeps live ones", async () => {
    await writeSidecar(statePaths, meta("mon_dead", DEAD_PID));
    writeFileSync(logPath(statePaths, "mon_dead"), "x");
    await writeSidecar(statePaths, meta("mon_live", process.pid));
    await sweepMonitors(statePaths);
    expect(existsSync(sidecarPath(statePaths, "mon_dead"))).toBe(false);
    expect(existsSync(logPath(statePaths, "mon_dead"))).toBe(false);
    expect(existsSync(sidecarPath(statePaths, "mon_live"))).toBe(true);
  });
});
