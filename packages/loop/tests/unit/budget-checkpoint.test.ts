import { describe, it, expect } from "../bun-test.ts";
import {
  createSoftBudget,
  createTokenLedger,
  createIterationCounter,
  runBudgetCheckpoint,
} from "../../src/runtime/budget/index.ts";
import { createTrace } from "@clarvis/trace";

describe("runBudgetCheckpoint — cancelled outcome", () => {
  it("returns cancelled when the soft-limit ask rejects under an aborted signal", async () => {
    const softBudget = createSoftBudget({ softTokenLimit: 10 })!;
    const ledger = createTokenLedger(1000);
    ledger.consume({ input_tokens: 10, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 });
    const counter = createIterationCounter(1000);
    const controller = new AbortController();
    controller.abort();
    const trace = createTrace();

    const outcome = await runBudgetCheckpoint({
      softBudget,
      softLimitAsk: () => Promise.reject(new Error("interrupted")),
      ledger,
      counter,
      agent: "lead",
      signal: controller.signal,
      trace,
    });

    expect(outcome).toEqual({ kind: "cancelled" });
  });
});
