import { describe, expect, it } from "bun:test";
import type { TraceEvent } from "@clarvis/capability";
import {
  JOURNAL_VERSION,
  journalToRecord,
  parseJournalChunks,
  repairUnsettledToolCalls,
} from "@clarvis/trace";

import {
  JOURNAL_STARTED_AT,
  journalHeader,
  leadIteration,
  subagentIteration,
} from "../helpers/journal-fixtures.ts";

async function* one(value: string): AsyncGenerator<string> {
  yield value;
}

const UNBOUNDED = {
  maxChars: Number.MAX_SAFE_INTEGER,
  maxLineChars: Number.MAX_SAFE_INTEGER,
  maxEvents: Number.MAX_SAFE_INTEGER,
};

const parseWhole = (text: string): ReturnType<typeof parseJournalChunks> =>
  parseJournalChunks(one(text), UNBOUNDED);

describe("parseJournalChunks", () => {
  it("rejects an empty file and a bad header", async () => {
    expect(await parseWhole("")).toEqual({ ok: false, reason: "empty" });
    expect(await parseWhole("{not json\n")).toEqual({ ok: false, reason: "bad_header" });
    expect(await parseWhole(`${JSON.stringify({ v: 1 })}\n`)).toEqual({
      ok: false,
      reason: "bad_header",
    });
  });

  it("refuses a journal written by a newer format version", async () => {
    const line = JSON.stringify({ ...journalHeader("exec-n"), v: JOURNAL_VERSION + 1 });
    expect(await parseWhole(`${line}\n`)).toEqual({ ok: false, reason: "bad_header" });
  });

  it("drops a truncated trailing line without counting it as damage", async () => {
    const head = JSON.stringify({ ...journalHeader("exec-t"), v: JOURNAL_VERSION });
    const good = JSON.stringify(leadIteration(1, 5, 1));
    const parsed = await parseWhole(`${head}\n${good}\n{"type":"lead_iter`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.events).toHaveLength(1);
    expect(parsed.skipped).toBe(0);
  });

  it("keeps an event type this build does not know", async () => {
    const head = JSON.stringify({ ...journalHeader("exec-u"), v: JOURNAL_VERSION });
    const text = `${head}\n${JSON.stringify({ type: "from_the_future", occurred_at: 1 })}\n`;
    const parsed = await parseWhole(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.events).toHaveLength(1);
    expect(parsed.skipped).toBe(0);
  });

  it("skips a well-formed line that is not a typed event object", async () => {
    const head = JSON.stringify({ ...journalHeader("exec-o"), v: JOURNAL_VERSION });
    const text = `${head}\n[1,2,3]\n{"no":"type"}\n${JSON.stringify(leadIteration(1, 1, 1))}\n`;
    const parsed = await parseWhole(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.events).toHaveLength(1);
    expect(parsed.skipped).toBe(2);
  });

  it("skips a damaged interior line but keeps the rest", async () => {
    const head = JSON.stringify({ ...journalHeader("exec-i"), v: JOURNAL_VERSION });
    const text = `${head}\nnot-json\n${JSON.stringify(leadIteration(2, 1, 1))}\n`;
    const parsed = await parseWhole(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.events).toHaveLength(1);
    expect(parsed.skipped).toBe(1);
  });

  it("parses chunks incrementally without requiring line-aligned input", async () => {
    const text =
      `${JSON.stringify({ ...journalHeader("exec-stream"), v: JOURNAL_VERSION })}\n` +
      `${JSON.stringify(leadIteration(1, 3, 1))}\n`;
    async function* chunks(): AsyncGenerator<string> {
      for (let at = 0; at < text.length; at += 7) yield text.slice(at, at + 7);
    }
    const parsed = await parseJournalChunks(chunks(), {
      maxChars: 1_000_000,
      maxLineChars: 100_000,
      maxEvents: 10,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.events).toHaveLength(1);
  });

  it("stops at aggregate, line and event bounds", async () => {
    const head = `${JSON.stringify({ ...journalHeader("exec-bound"), v: JOURNAL_VERSION })}\n`;
    const event = `${JSON.stringify(leadIteration(1, 1, 1))}\n`;
    await expect(
      parseJournalChunks(one(head), {
        maxChars: head.length - 1,
        maxLineChars: head.length,
        maxEvents: 10,
      }),
    ).resolves.toEqual({ ok: false, reason: "limit", limit: "chars" });
    await expect(
      parseJournalChunks(one(head), {
        maxChars: head.length,
        maxLineChars: 10,
        maxEvents: 10,
      }),
    ).resolves.toEqual({ ok: false, reason: "limit", limit: "line_chars" });
    await expect(
      parseJournalChunks(one(head + event), {
        maxChars: head.length + event.length,
        maxLineChars: head.length,
        maxEvents: 0,
      }),
    ).resolves.toEqual({ ok: false, reason: "limit", limit: "events" });
  });
});

describe("repairUnsettledToolCalls", () => {
  const started: TraceEvent = {
    type: "tool_call_started",
    agent: "lead",
    call_id: "c1",
    iteration_ref: 1,
    started_at: JOURNAL_STARTED_AT,
    mcp_name: "fs",
    tool_name: "read",
    arguments: { path: "a" },
  };

  it("synthesizes a result for a call that never settled", () => {
    const out = repairUnsettledToolCalls([started]);
    expect(out).toHaveLength(2);
    const repair = out[1] as Extract<TraceEvent, { type: "tool_call" }>;
    expect(repair.type).toBe("tool_call");
    expect(repair.call_id).toBe("c1");
    expect(repair.error).toContain("was not completed");
    expect(repair.result).toContain("fs.read");
  });

  it("leaves a settled call alone", () => {
    const settled: TraceEvent = {
      type: "tool_call",
      agent: "lead",
      call_id: "c1",
      iteration_ref: 1,
      started_at: JOURNAL_STARTED_AT,
      ended_at: JOURNAL_STARTED_AT + 1,
      mcp_name: "fs",
      tool_name: "read",
      arguments: {},
      result: "ok",
      error: null,
    };
    expect(repairUnsettledToolCalls([started, settled])).toHaveLength(2);
  });

  it("passes a contributed event through without pairing its call id", () => {
    const contributed: TraceEvent = {
      type: "plan_review",
      occurred_at: JOURNAL_STARTED_AT,
      detail: { outcome: "approved", revision_index: 1 },
    };
    const out = repairUnsettledToolCalls([started, contributed]);
    expect(out).toHaveLength(3);
    expect(out[1]).toBe(contributed);
    expect((out[2] as Extract<TraceEvent, { type: "tool_call" }>).call_id).toBe("c1");
  });
});

describe("journalToRecord", () => {
  it("sums usage, marks the run interrupted, and carries no final context", async () => {
    const parsed = await parseWhole(
      [
        JSON.stringify({ ...journalHeader("exec-r"), v: JOURNAL_VERSION }),
        JSON.stringify(leadIteration(1, 100, 20)),
        JSON.stringify(leadIteration(2, 50, 10)),
        "",
      ].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const record = journalToRecord(parsed);

    expect(record.status).toBe("interrupted");
    expect(record.response.status).toBe("interrupted");
    expect(record.total_input_tokens).toBe(150);
    expect(record.total_output_tokens).toBe(30);
    expect(record.response.usage.iterations_used).toBe(2);
    expect(record.final_context).toBeUndefined();
    expect(record.elapsed_ms).toBeGreaterThan(0);
  });

  it("restores host metadata from a crash journal", async () => {
    const environment = {
      environment: {
        id: "global:research",
        fingerprint: `sha256:${"b".repeat(64)}`,
      },
    };
    const parsed = await parseWhole(
      [
        JSON.stringify({
          ...journalHeader("exec-environment"),
          v: JOURNAL_VERSION,
          host_metadata: environment,
        }),
        JSON.stringify(leadIteration(1, 1, 1)),
        "",
      ].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(journalToRecord(parsed).host_metadata).toEqual(environment);
  });

  it("rolls subagent iterations up per model and counts distinct instances", async () => {
    const parsed = await parseWhole(
      [
        JSON.stringify({ ...journalHeader("exec-s"), v: JOURNAL_VERSION }),
        JSON.stringify(leadIteration(1, 100, 20)),
        JSON.stringify(subagentIteration("w1", 1, 7, 3)),
        JSON.stringify(subagentIteration("w1", 2, 5, 2)),
        JSON.stringify(subagentIteration("w2", 1, 1, 1)),
        "",
      ].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const record = journalToRecord(parsed);

    expect(record.total_input_tokens).toBe(113);
    expect(record.total_output_tokens).toBe(26);
    expect(record.total_cached_tokens).toBe(3);
    expect(record.total_cache_write_tokens).toBe(6);

    const sub = record.response.usage.by_agent.find((agent) => agent.type === "subagent");
    expect(sub).toBeDefined();
    expect(sub!.model).toBe("anthropic/small");
    expect(sub!.iterations).toBe(3);
    expect((sub as { instances?: number }).instances).toBe(2);

    const lead = record.response.usage.by_agent.find((agent) => agent.type === "lead");
    expect(lead!.input_tokens).toBe(100);
  });

  it("keeps a second model's tallies separate", async () => {
    const parsed = await parseWhole(
      [
        JSON.stringify({ ...journalHeader("exec-m"), v: JOURNAL_VERSION }),
        JSON.stringify(subagentIteration("w1", 1, 4, 1, "anthropic/small")),
        JSON.stringify(subagentIteration("w2", 1, 6, 2, "openai/mini")),
        "",
      ].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(
      journalToRecord(parsed)
        .response.usage.by_agent.map((agent) => agent.model)
        .sort(),
    ).toEqual(["anthropic/small", "openai/mini"]);
  });

  it("ignores contributed events for usage but includes them in elapsed time", async () => {
    const parsed = await parseWhole(
      [
        JSON.stringify({ ...journalHeader("exec-c"), v: JOURNAL_VERSION }),
        JSON.stringify(leadIteration(1, 100, 20)),
        JSON.stringify({
          type: "plan_review",
          occurred_at: JOURNAL_STARTED_AT + 999,
          detail: { outcome: "approved", revision_index: 1 },
        }),
        "",
      ].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const record = journalToRecord(parsed);

    expect(record.total_input_tokens).toBe(100);
    expect(record.total_output_tokens).toBe(20);
    expect(record.response.usage.iterations_used).toBe(1);
    expect(record.response.usage.by_agent).toHaveLength(1);
    expect(record.elapsed_ms).toBe(999);
  });

  it("carries no recovery field when the journal parsed cleanly", async () => {
    const parsed = await parseWhole(
      [
        JSON.stringify({ ...journalHeader("exec-clean"), v: JOURNAL_VERSION }),
        JSON.stringify(leadIteration(1, 10, 2)),
        "",
      ].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const record = journalToRecord(parsed);
    expect(record.recovery).toBeUndefined();
    expect(Object.hasOwn(record, "recovery")).toBe(false);
  });

  it("reports skipped lines on the record, not only in a log", async () => {
    const parsed = await parseWhole(
      [
        JSON.stringify({ ...journalHeader("exec-skip"), v: JOURNAL_VERSION }),
        "not-json",
        "[1,2,3]",
        JSON.stringify(leadIteration(1, 10, 2)),
        "",
      ].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(journalToRecord(parsed).recovery).toEqual({
      skipped_lines: 2,
      synthesized_tool_calls: 0,
    });
  });

  it("reports synthesized tool calls on the record", async () => {
    const parsed = await parseWhole(
      [
        JSON.stringify({ ...journalHeader("exec-synth"), v: JOURNAL_VERSION }),
        JSON.stringify({
          type: "tool_call_started",
          agent: "lead",
          call_id: "c9",
          iteration_ref: 1,
          started_at: JOURNAL_STARTED_AT,
          mcp_name: "fs",
          tool_name: "read",
          arguments: { path: "a" },
        }),
        "",
      ].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(journalToRecord(parsed).recovery).toEqual({
      skipped_lines: 0,
      synthesized_tool_calls: 1,
    });
  });
});
