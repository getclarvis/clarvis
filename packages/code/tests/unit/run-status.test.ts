import { expect, test } from "bun:test";
import {
  liveRunStatusLine,
  memoryNoticeText,
  progressStatusText,
  runStripText,
} from "../../src/features/run/status-presenter.ts";
import type { MemoryIngestNotice, RunProgress } from "../../src/adapters/run-types.ts";

function progress(over: Partial<RunProgress>): RunProgress {
  return { label: "", counter: 0, ...over };
}

test("a plan task transition shows the client-composed plan revision", () => {
  expect(progressStatusText(progress({ label: "plan r4", event: { type: "plan_updated" } }))).toBe(
    "plan r4",
  );
});

test("non-completed run endings read as 'ended — reason'", () => {
  expect(
    progressStatusText(
      progress({
        label: "Ended — budget_exhausted",
        event: { type: "run_ended", reason: "budget_exhausted" },
      }),
    ),
  ).toBe("ended — budget exhausted");
  expect(
    progressStatusText(
      progress({ label: "Completed", event: { type: "run_ended", reason: "completed" } }),
    ),
  ).toBe("Completed");
});

test("every other event passes the label through verbatim", () => {
  expect(
    progressStatusText(
      progress({
        label: "Explorer 6 thinking — step 4",
        event: { type: "iteration_started" },
      }),
    ),
  ).toBe("Explorer 6 thinking — step 4");
  expect(progressStatusText(progress({ label: "Lead → read_file(src/app.ts)" }))).toBe(
    "Lead → read_file(src/app.ts)",
  );
});

test("an empty label falls back to the iteration counter", () => {
  expect(progressStatusText(progress({ iteration: 7 }))).toBe("iteration 7");
  expect(progressStatusText(progress({}))).toBe("iteration ?");
});

test("a malformed event summary degrades to the label", () => {
  expect(
    progressStatusText(progress({ label: "Task t9 → done", event: { type: "plan_updated" } })),
  ).toBe("Task t9 → done");
});

test("the live footer line composes progress · elapsed · live tokens during a run", () => {
  expect(
    liveRunStatusLine({
      status: "Lead → bash(bun test)",
      startedAt: 1_000,
      now: 96_000,
      usage: { input: 1200, output: 345 },
    }),
  ).toBe("Lead → bash(bun test)  ·  1m35s  ·  1200→345 tok");
});

test("the live footer line degrades piecewise while start/usage are still unknown", () => {
  expect(liveRunStatusLine({ status: "running…", startedAt: null, now: 5, usage: null })).toBe(
    "running…",
  );
  expect(liveRunStatusLine({ status: "", startedAt: 1_000, now: 3_400, usage: null })).toBe("2s");
});

test("the canonical run strip owns terminal outcomes, context and wide usage", () => {
  expect(
    runStripText({
      active: true,
      status: "running iteration 4",
      startedAt: 1_000,
      now: 66_000,
      context: { used: 25_000, limit: 100_000 },
      usage: { input: 12_400, output: 820 },
      width: 160,
    }),
  ).toBe("Context 25% · Run  In 12k · Out 820");
  expect(
    runStripText({
      active: false,
      status: "model error",
      startedAt: null,
      now: 0,
      context: { used: 1, limit: 0 },
      width: 80,
    }),
  ).toBe("Failed · Context 0%");
});

test("the strip's run tokens report what was read, not what was in the window", () => {
  expect(
    runStripText({
      active: true,
      status: "running",
      startedAt: null,
      now: 0,
      context: { used: 25_000, limit: 100_000 },
      usage: { input: 12_400, output: 820, cached: 10_000 },
      width: 160,
    }),
  ).toBe("Context 25% · Run  In 2.4k · Out 820 · Cache hit 81%");
});

test("a provider that reports no cache split leaves the run tokens gross", () => {
  expect(
    runStripText({
      active: true,
      status: "running",
      startedAt: null,
      now: 0,
      usage: { input: 12_400, output: 820 },
      width: 160,
    }),
  ).toBe("Run  In 12k · Out 820");
});

test("cache hit percentage is scoped independently to the run or cumulative session", () => {
  const shared = {
    active: true,
    status: "running",
    startedAt: null,
    now: 0,
    width: 160,
  };
  expect(
    runStripText({
      ...shared,
      usage: { input: 10_000, output: 500, cached: 8_000 },
    }),
  ).toBe("Run  In 2.0k · Out 500 · Cache hit 80%");
  expect(
    runStripText({
      ...shared,
      usage: { input: 10_000, output: 500, cached: 8_000 },
      sessionUsage: { input: 40_000, output: 2_000, cached: 20_000 },
    }),
  ).toBe("Session  In 20k · Out 2.0k · Cache hit 50%");
});

test("cache hit percentage omits an empty denominator and bounds malformed provider totals", () => {
  const shared = {
    active: true,
    status: "running",
    startedAt: null,
    now: 0,
    width: 160,
  };
  expect(runStripText({ ...shared, usage: { input: 0, output: 5, cached: 0 } })).toBe(
    "Run  In 0 · Out 5",
  );
  expect(runStripText({ ...shared, usage: { input: 10, output: 5, cached: 40 } })).toBe(
    "Run  In 0 · Out 5 · Cache hit 100%",
  );
  expect(runStripText({ ...shared, usage: { input: 10, output: 5, cached: 0 } })).toBe(
    "Run  In 10 · Out 5 · Cache hit 0%",
  );
});

test("the run strip keeps cumulative session cost without duplicating run token counts", () => {
  expect(
    runStripText({
      active: false,
      status: "completed",
      startedAt: null,
      now: 0,
      context: { used: 25_000, limit: 100_000 },
      sessionCost: "$0.042",
      width: 100,
    }),
  ).toBe("Completed · Context 25% · Session $0.042");
});

test("the run strip keeps cumulative session tokens before and after a run settles", () => {
  const shared = {
    status: "completed",
    startedAt: null,
    now: 0,
    context: { used: 25_000, limit: 100_000 },
    usage: { input: 500, output: 50 },
    sessionUsage: { input: 120_000, output: 12_000, cached: 1_000 },
    width: 160,
  };
  expect(runStripText({ ...shared, active: true })).toContain(
    "Session  In 119k · Out 12k · Cache hit 1%",
  );
  expect(runStripText({ ...shared, active: false })).toBe(
    "Completed · Context 25% · Session  In 119k · Out 12k · Cache hit 1%",
  );
});

test("every memory ingest phase renders distinct text, including queued and blocked", () => {
  const notice = (over: Partial<MemoryIngestNotice>): MemoryIngestNotice => ({
    execution_id: "exec_1",
    phase: "started",
    ...over,
  });

  expect(memoryNoticeText(notice({ phase: "started" }))).toBe("memory: learning…");
  // Regression: the run's own event stream ends at "queued" on the happy path
  // (the index pass itself runs later, off the run), so this is the phase that
  // fires on every single run — it must never fall through unrecognized.
  expect(memoryNoticeText(notice({ phase: "queued" }))).toBe("memory: queued");
  expect(memoryNoticeText(notice({ phase: "blocked" }))).toBe("memory: blocked");
  expect(memoryNoticeText(notice({ phase: "blocked", note: "no model configured" }))).toBe(
    "memory: blocked (no model configured)",
  );
  expect(memoryNoticeText(notice({ phase: "failed", error: "boom" }))).toBe(
    "memory index failed — run not learned",
  );
  // A pass that ran and judged there was nothing durable is a different outcome
  // from one that failed, and both used to read as flat statements with no way
  // to look further. The failed one now names the run you can open.
  expect(memoryNoticeText(notice({ phase: "failed", indexer_run_id: "ix_9" }))).toBe(
    "memory index failed — run not learned (ix_9)",
  );
  expect(memoryNoticeText(notice({ phase: "done", skipped: true }))).toBe(
    "memory: nothing to record",
  );
  expect(memoryNoticeText(notice({ phase: "done", written: 2, deleted: 1 }))).toBe("memory +2 -1");
  expect(memoryNoticeText(notice({ phase: "done" }))).toBe("memory: nothing new");
});
