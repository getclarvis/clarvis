import { createConfigService, createFileConfigStore } from "../../src/config.ts";

const [globalDir, workerIndexRaw, iterationsRaw] = process.argv.slice(2);
const workerIndex = Number(workerIndexRaw);
const iterations = Number(iterationsRaw);

const REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function patchFor(index: number, iteration: number): Record<string, unknown> {
  switch (index % 4) {
    case 0:
      return { default_model: `w0/iter-${iteration}` };
    case 1:
      return { marketplaces: [`https://example.com/w1-iter-${iteration}.git`] };
    case 2:
      return { enabledPlugins: [`w2-iter-${iteration}`] };
    default:
      return { default_reasoning_effort: REASONING_EFFORTS[iteration % REASONING_EFFORTS.length] };
  }
}

const config = createConfigService(createFileConfigStore({ globalDir }));

for (let iteration = 0; iteration < iterations; iteration++) {
  for (;;) {
    const view = await config.getSettings();
    const revision = view.sources.find((source) => source.scope === "global")?.revision ?? null;
    try {
      await config.updateSettings("global", patchFor(workerIndex, iteration), revision);
      break;
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        (error as { code?: unknown }).code !== "conflict"
      ) {
        throw error;
      }
    }
  }
}
