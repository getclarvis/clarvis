import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
  promises as fsp,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HOME_ENV,
  setPathsLogger,
  sweepGlobalStateArtifacts,
  sweepSpillDir,
  workspaceStatePaths,
} from "@clarvis/paths";

import { recorder } from "../helpers/recorder.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
let root: string;
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clarvis-paths-spill-workspace-"));
  home = mkdtempSync(join(tmpdir(), "clarvis-paths-spill-home-"));
  previousHome = process.env[HOME_ENV];
  process.env[HOME_ENV] = home;
});

afterEach(() => {
  setPathsLogger(null);
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env[HOME_ENV];
  else process.env[HOME_ENV] = previousHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("sweepSpillDir", () => {
  test("returns quietly when the state directory does not exist", async () => {
    await expect(sweepSpillDir(root)).resolves.toBeUndefined();
    expect(existsSync(workspaceStatePaths(root).localDir)).toBe(false);
  });

  test("ignores a directory handle that fails while closing", async () => {
    const paths = workspaceStatePaths(root);
    mkdirSync(paths.localDir, { recursive: true });
    const handle = await fsp.opendir(paths.localDir);
    vi.spyOn(handle, "close").mockImplementation(() =>
      Promise.reject(new Error("close raced removal")),
    );
    vi.spyOn(fsp, "opendir").mockResolvedValue(handle);

    await expect(sweepSpillDir(root)).resolves.toBeUndefined();
  });

  test("removes old spills while preserving recent, monitor, directory and unrelated entries", async () => {
    const paths = workspaceStatePaths(root);
    mkdirSync(paths.localDir, { recursive: true });
    const staleTime = new Date(Date.now() - 2 * DAY_MS);
    const stale = paths.spillFile("stale", "stdout");
    writeFileSync(stale, "old");
    utimesSync(stale, staleTime, staleTime);
    const fresh = paths.spillFile("fresh", "stderr");
    writeFileSync(fresh, "new");
    const monitor = paths.monitorLog("mon_1");
    writeFileSync(monitor, "monitor");
    utimesSync(monitor, staleTime, staleTime);
    const unrelated = join(paths.localDir, "keep.txt");
    writeFileSync(unrelated, "keep");
    const directory = join(paths.localDir, "shell-subdir.log");
    mkdirSync(directory);

    await sweepSpillDir(root);

    expect(existsSync(stale)).toBe(false);
    for (const kept of [fresh, monitor, unrelated, directory]) expect(existsSync(kept)).toBe(true);
  });

  test("recognises both shell stream names and generic tool-result names", async () => {
    const paths = workspaceStatePaths(root);
    mkdirSync(paths.localDir, { recursive: true });
    const staleTime = new Date(Date.now() - 2 * DAY_MS);
    const spills = [
      paths.spillFile("tok", "stdout"),
      paths.spillFile("tok", "stderr"),
      paths.toolOutputSpill("old"),
    ];
    for (const spill of spills) {
      writeFileSync(spill, "x");
      utimesSync(spill, staleTime, staleTime);
    }
    const fresh = paths.toolOutputSpill("new");
    writeFileSync(fresh, "x");

    await sweepSpillDir(root);

    for (const spill of spills) expect(existsSync(spill)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("ignores stat failures and leaves the spill in place", async () => {
    const paths = workspaceStatePaths(root);
    mkdirSync(paths.localDir, { recursive: true });
    const spill = paths.spillFile("x", "stdout");
    writeFileSync(spill, "data");
    const spy = vi.spyOn(fsp, "lstat").mockRejectedValue(new Error("boom"));

    await expect(sweepSpillDir(root)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    expect(existsSync(spill)).toBe(true);
  });

  test("bounds each scan instead of materialising an arbitrarily large directory", async () => {
    const paths = workspaceStatePaths(root);
    mkdirSync(paths.localDir, { recursive: true });
    const staleTime = new Date(Date.now() - 2 * DAY_MS);
    const spills = Array.from({ length: 8 }, (_, index) =>
      paths.spillFile(`bounded-${index}`, "stdout"),
    );
    for (const spill of spills) {
      writeFileSync(spill, "old");
      utimesSync(spill, staleTime, staleTime);
    }

    await sweepSpillDir(root, { maxEntries: 3, concurrency: 2 });

    expect(spills.filter((spill) => !existsSync(spill))).toHaveLength(3);
    expect(spills.filter((spill) => existsSync(spill))).toHaveLength(5);
  });
});

describe("sweepGlobalStateArtifacts", () => {
  test("bounds the number of workspace roots visited in one pass", async () => {
    mkdirSync(workspaceStatePaths(root).localDir, { recursive: true });
    const secondRoot = join(root, "second");
    mkdirSync(secondRoot);
    mkdirSync(workspaceStatePaths(secondRoot).localDir, { recursive: true });

    const report = await sweepGlobalStateArtifacts(home, { maxWorkspaces: 1 });

    expect(report.workspaces).toBe(1);
    expect(report.truncated).toBe(true);
  });

  test("repairs recent spill modes and removes stale spills across inactive workspaces", async () => {
    const first = workspaceStatePaths(root);
    const secondRoot = join(root, "other");
    mkdirSync(secondRoot);
    const second = workspaceStatePaths(secondRoot);
    for (const paths of [first, second]) mkdirSync(paths.localDir, { recursive: true });
    const recent = first.toolOutputSpill("recent");
    writeFileSync(recent, "new", { mode: 0o644 });
    const stale = second.spillFile("stale", "stdout");
    writeFileSync(stale, "old", { mode: 0o644 });
    const staleTime = new Date(Date.now() - 2 * DAY_MS);
    utimesSync(stale, staleTime, staleTime);

    const report = await sweepGlobalStateArtifacts(home);

    expect(report.workspaces).toBe(2);
    expect(report.spillsRemoved).toBe(1);
    expect(existsSync(stale)).toBe(false);
    if (process.platform !== "win32") expect(statSync(recent).mode & 0o777).toBe(0o600);
  });

  test("removes only stale empty run containers", async () => {
    const paths = workspaceStatePaths(root);
    const stale = paths.runDir("stale");
    const active = paths.runDir("active");
    const occupied = paths.runDir("occupied");
    for (const dir of [join(stale, "tmp"), join(active, "tmp"), join(occupied, "tmp")]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(occupied, "tmp", "keep"), "x");
    const staleTime = new Date(Date.now() - 2 * DAY_MS);
    utimesSync(stale, staleTime, staleTime);
    utimesSync(occupied, staleTime, staleTime);

    const report = await sweepGlobalStateArtifacts(home);

    expect(report.runDirsRemoved).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(occupied)).toBe(true);
  });
});

describe("sweep diagnostics", () => {
  const spill = (dir: string, name: string, ageMs: number): string => {
    const file = join(dir, name);
    writeFileSync(file, "x");
    const stamp = new Date(Date.now() - ageMs);
    utimesSync(file, stamp, stamp);
    return file;
  };

  test("a completed pass reports what it scanned and what it removed", async () => {
    const dir = workspaceStatePaths(root).localDir;
    mkdirSync(dir, { recursive: true });
    spill(dir, "shell-old.stdout.log", 2 * DAY_MS);
    spill(dir, "shell-new.stdout.log", 0);
    writeFileSync(join(dir, "unrelated.txt"), "x");
    const sink = recorder();
    await sweepSpillDir(root, { logger: sink.logger });
    expect(sink.events("paths.spill_sweep")[0]).toMatchObject({
      dir,
      scanned: 3,
      candidates: 2,
      removed: 1,
      truncated: false,
    });
  });

  test("a directory past the scan bound reports that the rest was never swept", async () => {
    const dir = workspaceStatePaths(root).localDir;
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 4; i += 1) spill(dir, `shell-${i}.stdout.log`, 2 * DAY_MS);
    const sink = recorder();
    setPathsLogger(sink.logger);
    await sweepSpillDir(root, { maxEntries: 2 });
    expect(sink.events("paths.spill_sweep")[0]).toMatchObject({
      dir,
      scanned: 3,
      candidates: 2,
      truncated: true,
    });
  });
});
