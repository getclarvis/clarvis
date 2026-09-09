import { expect, test } from "bun:test";
import type { RunUsage, SessionTotals } from "@clarvis/protocol";
import { addRunUsage } from "../../src/sessions/usage.ts";

test("session usage prices fresh input, cache reads and cache writes once across agents", () => {
  const totals: SessionTotals = { input: 10, output: 4, cached: 2 };
  addRunUsage(
    totals,
    {
      iterations: 1,
      elapsed_ms: 1,
      by_agent: [
        {
          role: "lead",
          model: "priced",
          input_tokens: 100,
          output_tokens: 20,
          cached_tokens: 30,
          cache_write_tokens: 10,
        },
        {
          role: "subagent",
          model: "unknown",
          input_tokens: 50,
          output_tokens: 5,
          cached_tokens: 0,
          cache_write_tokens: 0,
        },
      ],
    },
    (model) =>
      model === "priced" ? { input: 2, output: 4, cache_read: 1, cache_write: 3 } : undefined,
  );
  expect(totals).toEqual({
    input: 160,
    output: 29,
    cached: 32,
    cost_usd: (70 * 2 + 20 * 4 + 30 + 10 * 3) / 1e6,
  });
  addRunUsage(totals, { iterations: 1, elapsed_ms: 1, input_tokens: 1 });
  expect(totals.cached).toBeUndefined();
  const empty: SessionTotals = { input: 0, output: 0, cached: 0 };
  addRunUsage(empty, undefined);
  addRunUsage(empty, { iterations: 1, elapsed_ms: 1 } satisfies RunUsage);
  expect(empty).toEqual({ input: 0, output: 0, cached: 0 });
});
