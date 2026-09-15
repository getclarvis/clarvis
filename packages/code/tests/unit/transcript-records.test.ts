import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@clarvis/protocol";
import { applyEvent, createTranscriptStore } from "../../src/adapters/store.ts";
import { TranscriptRows, isExplorationTool } from "../../src/core/transcript/rows.ts";
import { TranscriptWindow } from "../../src/core/transcript/window.ts";
import { transcriptToolEvents } from "../helpers/transcript-fixtures.ts";

describe("transcript records and first admission", () => {
  test("two actors sharing a call ID have independent authoritative results", () => {
    const store = createTranscriptStore();
    const sink = store.openRun("same-call");
    for (const actor of [undefined, "A", "B"])
      for (const event of transcriptToolEvents("same", "shell", actor))
        applyEvent(sink, event, "live");
    const tools = store.nodes.filter((node) => node.kind === "tool_call");
    expect(new Set(tools.map((node) => node.key)).size).toBe(3);
    expect(tools.map((node) => node.subagentId)).toEqual([undefined, "A", "B"]);
    expect(
      tools.every(
        (node) => node.result === "AUTHORITATIVE_RESULT" && node.liveOutput === undefined,
      ),
    ).toBe(true);
  });

  test("uncorrelated no-ID terminals keep deterministic distinct durable positions", () => {
    const events = [1, 2].map((index): RunEvent => ({
      type: "tool_call",
      at: 0,
      agent: "lead",
      server: "unknown",
      tool: "unknown",
      ok: true,
      result: `result-${index}`,
    }));
    const build = () => {
      const store = createTranscriptStore();
      const sink = store.openRun("uncorrelated");
      events.forEach((event) => applyEvent(sink, event, "replay"));
      return store.nodes;
    };
    expect(build().map((node) => node.key)).toEqual(build().map((node) => node.key));
    expect(new Set(build().map((node) => node.key)).size).toBe(2);
  });

  test("durable announcement preserves a cancelled composition and retry identity on restore", () => {
    const events: RunEvent[] = [
      {
        type: "tool_call_announced",
        at: 1,
        agent: "lead",
        call_id: "reused",
        tool: "write_file",
        iteration: 1,
        attempt: 1,
      },
      {
        type: "model_retry",
        at: 2,
        agent: "lead",
        iteration: 1,
        attempt: 1,
        max_retries: 3,
        delay_ms: 0,
        kind: "transient",
      },
      {
        type: "tool_call_announced",
        at: 3,
        agent: "lead",
        call_id: "reused",
        tool: "write_file",
        iteration: 1,
        attempt: 2,
      },
      { type: "run_ended", at: 4, status: "cancelled" },
    ];
    const reduce = (source: "live" | "replay") => {
      const store = createTranscriptStore();
      const sink = store.openRun("retry");
      events.forEach((event) => applyEvent(sink, event, source));
      sink.complete();
      return store.committedNodes().filter((node) => node.kind === "tool_call");
    };
    const live = reduce("live");
    expect(live).toEqual(reduce("replay"));
    expect(live.map((node) => node.toolPhase)).toEqual(["interrupted", "cancelled"]);
    expect(new Set(live.map((node) => node.key)).size).toBe(2);
  });

  test("a terminal result cannot be reopened by duplicate start or late deltas", () => {
    const store = createTranscriptStore();
    const sink = store.openRun("late");
    const events = transcriptToolEvents("call", "shell");
    events.forEach((event) => applyEvent(sink, event, "live"));
    for (const index of [0, 3, 4]) applyEvent(sink, events[index]!, "live");
    const node = store.nodes.find((candidate) => candidate.kind === "tool_call")!;
    expect(node).toMatchObject({
      status: "ok",
      toolPhase: "completed",
      result: "AUTHORITATIVE_RESULT",
    });
  });

  test("only explicitly known observing identities qualify for exploration", () => {
    for (const name of ["read_file", "grep", "glob"]) expect(isExplorationTool(name)).toBe(true);
    for (const name of ["shell", "write_file", "unknown", "remote.read_file"])
      expect(isExplorationTool(name)).toBe(false);
    expect(isExplorationTool("read_file", "remote")).toBe(false);
  });

  test("500 members keep a first-member wrapper and closed actor/turn boundaries", () => {
    const rows = new TranscriptRows();
    for (let index = 0; index < 500; index++)
      rows.admit({ id: `call-${index}`, kind: "exploration", projection: "lead", scope: "run-1" });
    const id = rows.select("lead")[0]!;
    expect(rows.select("lead")).toHaveLength(1);
    expect(rows.row(id)).toMatchObject({
      members: Array.from({ length: 500 }, (_, i) => `call-${i}`),
    });
    rows.admit({ id: "prose", kind: "part", projection: "lead", scope: "run-1" });
    rows.admit({ id: "call-500", kind: "exploration", projection: "lead", scope: "run-1" });
    rows.admit({ id: "call-0", kind: "exploration", projection: "lead", scope: "run-1" });
    expect(rows.select("lead")).toHaveLength(3);
    expect(rows.destination("call-0")).toBe(id);
    rows.retain(new Set(["prose", "call-500"]));
    expect(rows.select("lead")).toHaveLength(2);
  });

  test("80 to 81 and 1000 appended rows retain the reader and bound residence", () => {
    const window = new TranscriptWindow();
    window.sync(Array.from({ length: 80 }, (_, i) => `row-${i}`));
    window.reader = { mode: "anchor", rowId: "row-62", screenY: -3 };
    window.sync(Array.from({ length: 1081 }, (_, i) => `row-${i}`));
    expect(window.resident()).toHaveLength(40);
    expect(window.resident()).toContain("row-62");
    expect(window.reader).toEqual({ mode: "anchor", rowId: "row-62", screenY: -3 });
    window.tail();
    expect(window.resident().at(-1)).toBe("row-1080");
  });
});
