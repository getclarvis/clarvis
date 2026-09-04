import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConfigService, createFileConfigStore } from "../../src/config.ts";

const [globalDir, coordinationDir, workerIndexRaw, iterationsRaw] = process.argv.slice(2);
const workerIndex = Number(workerIndexRaw);
const iterations = Number(iterationsRaw);
const RETRY_DEADLINE_MS = 45_000;

const REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function patchFor(index: number, iteration: number): Record<string, unknown> {
  switch (index % 4) {
    case 0:
      return { default_model: `w0/iter-${iteration}` };
    case 1:
      return { marketplaces: [`https://example.com/w1-iter-${iteration}.git`] };
    case 2:
      return {
        enabledPlugins: [{ scope: "global", source: "clarvis", name: `w2-iter-${iteration}` }],
      };
    default:
      return { default_reasoning_effort: REASONING_EFFORTS[iteration % REASONING_EFFORTS.length] };
  }
}

const config = createConfigService(createFileConfigStore({ globalDir }));
const retryDeadline = Date.now() + RETRY_DEADLINE_MS;
let conflicts = 0;
let lockContentions = 0;

function mark(name: string): void {
  writeFileSync(join(coordinationDir, `${workerIndex}.${name}`), "");
}

async function waitFor(name: string): Promise<void> {
  while (!existsSync(join(coordinationDir, name))) {
    if (Date.now() >= retryDeadline) throw new Error(`timed out waiting for ${name}`);
    await Bun.sleep(5);
  }
}

function isConflict(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "conflict"
  );
}

function isLockContention(error: unknown): boolean {
  return error instanceof Error && error.message.includes("settings are locked by another process");
}

mark("ready");
await waitFor("start");

for (let iteration = 0; iteration < iterations; iteration++) {
  for (let attempt = 0; ; attempt++) {
    const view = await config.getSettings();
    const revision = view.sources.find((source) => source.scope === "global")?.revision ?? null;
    if (iteration === 0 && attempt === 0) {
      mark("loaded");
      await waitFor("commit");
    }
    try {
      await config.updateSettings("global", patchFor(workerIndex, iteration), revision);
      break;
    } catch (error) {
      if (isConflict(error)) conflicts += 1;
      else if (isLockContention(error)) lockContentions += 1;
      else throw error;
      if (Date.now() >= retryDeadline) throw error;
      await Bun.sleep(1 + ((workerIndex + attempt) % 7));
    }
  }
}

process.stdout.write(`${JSON.stringify({ conflicts, lockContentions })}\n`);
