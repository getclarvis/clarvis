import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { globalPaths } from "@clarvis/paths";
import { tempRoot } from "../helpers/temp-root.ts";

const WORKER_ENTRY = fileURLToPath(new URL("../helpers/settings-lock-worker.ts", import.meta.url));

const WORKER_COUNT = 4;
const ITERATIONS_PER_WORKER = 32;
const BARRIER_TIMEOUT_MS = 20_000;

interface WorkerOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Worker {
  outcome: Promise<WorkerOutcome>;
  close: () => Promise<void>;
}

function startWorker(globalDir: string, coordinationDir: string, index: number): Worker {
  const proc = Bun.spawn(
    [
      process.execPath,
      WORKER_ENTRY,
      globalDir,
      coordinationDir,
      String(index),
      String(ITERATIONS_PER_WORKER),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const outcome = Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
  return {
    outcome,
    close: async () => {
      if (proc.exitCode === null) proc.kill();
      await outcome;
    },
  };
}

async function waitForWorkers(coordinationDir: string, marker: string): Promise<void> {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  for (;;) {
    const ready = Array.from({ length: WORKER_COUNT }, (_, index) =>
      existsSync(join(coordinationDir, `${index}.${marker}`)),
    ).every(Boolean);
    if (ready) return;
    if (Date.now() >= deadline) {
      throw new Error(`workers did not reach the ${marker} barrier`);
    }
    await Bun.sleep(5);
  }
}

/**
 * `@clarvis/kernel`'s `ConfigStore.mutateSettings` is the only thing standing
 * between two real OS processes writing the same `settings.json` and one of
 * them silently losing a whole top-level block: `readSettings` + `writeSettings`
 * are only indivisible *within* one process, and nothing in-process can
 * reproduce a cross-process race, so this spawns real concurrent `bun`
 * processes against one shared global config directory.
 */
describe("ConfigStore.mutateSettings — real cross-process concurrent writers", () => {
  it("keeps every writer's top-level settings block, with no block ever going missing", async () => {
    const temp = await tempRoot("clarvis-settings-lock-");
    const globalDir = temp.path("global");
    const coordinationDir = temp.path("coordination");
    mkdirSync(coordinationDir);

    try {
      const workers = Array.from({ length: WORKER_COUNT }, (_, index) =>
        startWorker(globalDir, coordinationDir, index),
      );
      const unregisterWorkers = workers.map((worker, index) =>
        temp.register(`worker-${index}`, worker.close),
      );
      await waitForWorkers(coordinationDir, "ready");
      writeFileSync(join(coordinationDir, "start"), "");
      await waitForWorkers(coordinationDir, "loaded");
      writeFileSync(join(coordinationDir, "commit"), "");

      const outcomes = await Promise.all(workers.map((worker) => worker.outcome));
      unregisterWorkers.forEach((unregister) => unregister());
      outcomes.forEach((outcome, index) => {
        expect(outcome.exitCode, `worker ${index} failed:\n${outcome.stderr}`).toBe(0);
      });

      const reports = outcomes.map(
        ({ stdout }) => JSON.parse(stdout) as { conflicts: number; lockContentions: number },
      );
      expect(reports.reduce((total, report) => total + report.conflicts, 0)).toBeGreaterThan(0);

      const onDisk = JSON.parse(
        readFileSync(globalPaths(globalDir).settingsFile, "utf8"),
      ) as Record<string, unknown>;

      const lastIteration = ITERATIONS_PER_WORKER - 1;
      expect(onDisk.default_model).toBe(`w0/iter-${lastIteration}`);
      expect(onDisk.marketplaces).toEqual([`https://example.com/w1-iter-${lastIteration}.git`]);
      expect(onDisk.enabledPlugins).toEqual([
        { scope: "global", source: "agents", name: `w2-iter-${lastIteration}` },
      ]);
      expect(onDisk.default_reasoning_effort).toBeDefined();
    } finally {
      await temp.cleanup();
      expect(temp.pending()).toEqual([]);
    }
  });
});
