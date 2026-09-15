import { expect, test } from "bun:test";
import { batch, createRoot } from "solid-js";
import type { RunEvent } from "@clarvis/protocol";
import { applyEvent, createTranscriptStore } from "../../src/adapters/store.ts";
import { snapshotTranscriptNode } from "../../src/core/transcript/records.ts";
import { transcriptToolEvents } from "../helpers/transcript-fixtures.ts";

test("terminal records are bounded, frozen, and strip all incremental buffers", () => {
  const snapshot = snapshotTranscriptNode({
    key: "record",
    kind: "tool_call",
    status: "ok",
    toolPhase: "completed",
    text: "",
    result: "x".repeat(1_000_000),
    liveOutput: "duplicate",
    inputChars: 42,
    inputComplete: true,
    args: { content: "y".repeat(1_000_000) },
  });
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(JSON.stringify(snapshot).length).toBeLessThan(128 * 1024);
  expect(snapshot).not.toHaveProperty("liveOutput");
  expect(snapshot).not.toHaveProperty("inputChars");
  expect(snapshot).not.toHaveProperty("inputComplete");
});

for (const actor of [undefined, "child"]) {
  test(`terminal content seals immediately for ${actor ?? "Lead"} before body eviction`, () =>
    createRoot((dispose) => {
      try {
        const store = createTranscriptStore({ hydratedToolLimit: 1 });
        const sink = store.openRun("content");
        for (const event of transcriptToolEvents("first", "shell", actor))
          applyEvent(sink, event, "live");
        const first = store.committedNodes().find((node) => node.kind === "tool_call")!;
        for (const event of transcriptToolEvents("second", "shell", actor))
          applyEvent(sink, event, "live");
        expect(store.committedNodes().find((node) => node.key === first.key)).toBe(first);
        expect(first).toMatchObject({ result: "AUTHORITATIVE_RESULT" });
        expect(first.subagentId).toBe(actor);
        expect(store.nodes.find((node) => node.key === first.key)).toMatchObject({
          dehydrated: true,
        });
        expect(Object.isFrozen(first)).toBe(true);
      } finally {
        dispose();
      }
    }));
}

test("only authoritative reconciliation revises sealed content, coherently and with the same ID", () =>
  createRoot((dispose) => {
    try {
      const store = createTranscriptStore();
      const sink = store.openRun("revision");
      const events = transcriptToolEvents("same", "shell");
      for (const event of events) applyEvent(sink, event, "live");
      const first = store.committedNodes()[0]!;
      const corrected = { ...events.at(-1)!, result: "CORRECTED" } as RunEvent;
      applyEvent(sink, corrected, "live");
      expect(store.committedNodes()[0]).toBe(first);
      batch(() => {
        sink.beginReconcile();
        for (const event of [...events.slice(0, -1), corrected]) applyEvent(sink, event, "replay");
        expect(store.committedNodes()[0]).toBe(first);
        sink.endReconcile();
      });
      expect(store.committedNodes()[0]).toMatchObject({ key: first.key, result: "CORRECTED" });
      const revision = store.committedNodes()[0];
      batch(() => {
        sink.beginReconcile();
        for (const event of [...events.slice(0, -1), corrected]) applyEvent(sink, event, "replay");
        sink.endReconcile();
      });
      expect(store.committedNodes()[0]).toBe(revision);
    } finally {
      dispose();
    }
  }));

test("the host complete boundary seals the outcome, and completed sinks cannot resurrect records", () =>
  createRoot((dispose) => {
    try {
      const store = createTranscriptStore();
      const sink = store.openRun("end");
      applyEvent(sink, { type: "run_started", at: 0 }, "live");
      applyEvent(sink, { type: "run_ended", at: 1, status: "completed" }, "live");
      expect(store.committedNodes().some((node) => node.kind === "run")).toBe(false);
      sink.complete({ degraded: "Stored history could not be reconciled." });
      expect(store.committedNodes().some((node) => node.kind === "run")).toBe(true);
      expect(
        store.committedNodes().some((node) => node.text.includes("could not be reconciled")),
      ).toBe(true);
      store.clear();
      for (const event of transcriptToolEvents("late")) applyEvent(sink, event, "live");
      sink.complete();
      expect(store.nodes).toHaveLength(0);
      expect(store.committedNodes()).toHaveLength(0);
    } finally {
      dispose();
    }
  }));

test("retention replaces discarded content with one bounded notice and releases record identities", () =>
  createRoot((dispose) => {
    try {
      const store = createTranscriptStore();
      const first = store.appendUserMessage("first");
      store.appendNotice("old");
      const second = store.appendUserMessage("second");
      expect(first).not.toBe(second);
      expect(store.foldPrefixBefore(second, "Earlier history retained by the host.")).toBe(true);
      expect(store.committedNodes()).toHaveLength(2);
      expect(store.committedNodes().some((node) => node.key === first)).toBe(false);
      expect(store.committedNodes()[0]).toMatchObject({ key: "transcript:folded-prefix" });
      store.clear();
      expect(store.memory?.().sealed_records).toBe(0);
    } finally {
      dispose();
    }
  }));

test("live and stored admission seal equal results despite duplicate terminal delivery", () => {
  const events = [...transcriptToolEvents("a"), ...transcriptToolEvents("b", "shell", "child")];
  const ledger = (source: "live" | "replay") =>
    createRoot((dispose) => {
      try {
        const store = createTranscriptStore();
        const sink = store.openRun("equal");
        if (source === "replay") sink.beginReconcile();
        for (const event of events) applyEvent(sink, event, source);
        applyEvent(sink, events.at(-1)!, source);
        if (source === "replay") sink.endReconcile();
        sink.complete();
        return JSON.stringify(store.committedNodes());
      } finally {
        dispose();
      }
    });
  expect(ledger("live")).toBe(ledger("replay"));
});
