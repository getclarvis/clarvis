import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { globalPaths } from "@clarvis/paths";

const WORKER_ENTRY = fileURLToPath(new URL("../helpers/settings-lock-worker.ts", import.meta.url));

const WORKER_COUNT = 8;
const ITERATIONS_PER_WORKER = 250;

interface WorkerOutcome {
  exitCode: number;
  stderr: string;
}

async function runWorker(globalDir: string, index: number): Promise<WorkerOutcome> {
  const proc = Bun.spawn(
    [process.execPath, WORKER_ENTRY, globalDir, String(index), String(ITERATIONS_PER_WORKER)],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { exitCode, stderr };
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
    const globalDir = mkdtempSync(join(tmpdir(), "clarvis-settings-lock-"));

    const outcomes = await Promise.all(
      Array.from({ length: WORKER_COUNT }, (_, index) => runWorker(globalDir, index)),
    );

    outcomes.forEach((outcome, index) => {
      expect(outcome.exitCode, `worker ${index} failed:\n${outcome.stderr}`).toBe(0);
    });

    const onDisk = JSON.parse(readFileSync(globalPaths(globalDir).settingsFile, "utf8")) as Record<
      string,
      unknown
    >;

    const lastIteration = ITERATIONS_PER_WORKER - 1;
    expect(onDisk.default_model).toBe(`w0/iter-${lastIteration}`);
    expect(onDisk.marketplaces).toEqual([`https://example.com/w1-iter-${lastIteration}.git`]);
    expect(onDisk.enabledPlugins).toEqual([
      { scope: "global", source: "clarvis", name: `w2-iter-${lastIteration}` },
    ]);
    expect(onDisk.default_reasoning_effort).toBeDefined();
  });
});
