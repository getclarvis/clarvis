import { expect, test } from "bun:test";
import { CodeRenderable, DiffRenderable } from "@opentui/core";
import { TestRecorder } from "@opentui/core/testing";
import { applyEvent } from "../../src/adapters/store.ts";
import { transcriptToolEvents } from "../helpers/transcript-fixtures.ts";
import { openTranscript, transcriptRenderables } from "../helpers/transcript-render.tsx";
import { settleSyntaxSurfaces } from "../helpers/tracked-render.ts";

test("terminal diff and code parsers survive unrelated events and the next user message", async () => {
  const fixture = await openTranscript();
  const sink = fixture.store.openRun("syntax");
  const diff = "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new";
  try {
    applyEvent(
      sink,
      {
        type: "tool_call",
        at: 1,
        agent: "lead",
        call_id: "edit",
        server: "edit_file",
        tool: "",
        arguments: { path: "a.ts" },
        result: "updated",
        diff,
        ok: true,
      },
      "live",
    );
    applyEvent(
      sink,
      {
        type: "tool_call",
        at: 2,
        agent: "lead",
        call_id: "write",
        server: "write_file",
        tool: "",
        arguments: { path: "b.ts", content: "export const value = 42;" },
        result: "written",
        ok: true,
      },
      "live",
    );
    await fixture.frames();
    for (const id of fixture.history().snapshot().rowIds) fixture.transcript.toggleAt(id);
    await settleSyntaxSurfaces(fixture.rendered);
    await fixture.frames(5);
    const parsers = transcriptRenderables(fixture.rendered.renderer.root).filter(
      (node) => node instanceof CodeRenderable || node instanceof DiffRenderable,
    );
    expect(parsers.some((node) => node instanceof DiffRenderable)).toBe(true);
    expect(parsers.some((node) => node instanceof CodeRenderable)).toBe(true);
    for (const event of transcriptToolEvents("stream", "shell").slice(0, -1))
      applyEvent(sink, event, "live");
    for (let i = 0; i < 30; i++) {
      applyEvent(
        sink,
        {
          type: "tool_output_delta",
          agent: "lead",
          call_id: "stream",
          at: 10 + i,
          chunk: "tick\n",
        },
        "live",
      );
      await fixture.frames(1);
      const mounted = transcriptRenderables(fixture.rendered.renderer.root);
      for (const parser of parsers) expect(mounted).toContain(parser);
    }
    fixture.store.appendUserMessage("NEXT");
    await fixture.frames();
    for (const parser of parsers) expect(parser.isDestroyed).toBe(false);
    fixture.history().revealKey(fixture.history().snapshot().rowIds[0]!);
    await fixture.frames(5);
    const reader = fixture.history().snapshot().reader;
    fixture.resize(80, 24);
    fixture.setSplit(true);
    await settleSyntaxSurfaces(fixture.rendered);
    await fixture.frames(5);
    expect(fixture.history().snapshot().reader).toEqual(reader);
    expect(fixture.rendered.captureCharFrame()).toContain("edit_file");
    for (const parser of parsers) expect(parser.isDestroyed).toBe(false);
    fixture.setSplit(false);
    fixture.resize(120, 32);
    await fixture.frames(5);
    expect(fixture.history().snapshot().reader).toEqual(reader);
  } finally {
    fixture.rendered.renderer.destroy();
  }
});

test("the streamed final answer retains its native row through host completion and authoritative replay", async () => {
  const fixture = await openTranscript();
  const sink = fixture.store.openRun("answer");
  const recorder = new TestRecorder(fixture.rendered.renderer);
  recorder.rec();
  try {
    applyEvent(
      sink,
      { type: "iteration_started", agent: "lead", iteration: 1, model: "fixture", at: 0 },
      "live",
    );
    applyEvent(
      sink,
      {
        type: "text_delta",
        agent: "lead",
        iteration: 1,
        channel: "text",
        text: "FINAL ANSWER",
        reset: false,
        at: 1,
      },
      "live",
    );
    await fixture.frames();
    const id = fixture.history().snapshot().rowIds[0]!;
    const row = fixture.scrollbox().content.findDescendantById(`transcript-row:${id}`);
    applyEvent(
      sink,
      {
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        model: "fixture",
        at: 2,
        response: "FINAL ANSWER",
        response_phase: "final_answer",
        input_tokens: 1,
        output_tokens: 1,
      },
      "live",
    );
    applyEvent(sink, { type: "run_ended", at: 3, status: "completed" }, "live");
    await fixture.frames();
    expect(fixture.history().snapshot().rowIds).toEqual([id]);
    sink.complete();
    await fixture.frames(5);
    expect(fixture.history().snapshot().rowIds).toEqual([id, "answer::run"]);
    expect(fixture.scrollbox().content.findDescendantById(`transcript-row:${id}`)).toBe(row);
    expect(fixture.rendered.captureCharFrame()).toContain("FINAL ANSWER");
    const restored = fixture.store.openRun("answer");
    restored.beginReconcile();
    applyEvent(
      restored,
      { type: "iteration_started", agent: "lead", iteration: 1, model: "fixture", at: 0 },
      "replay",
    );
    applyEvent(
      restored,
      {
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        model: "fixture",
        at: 2,
        response: "FINAL ANSWER CORRECTED",
        response_phase: "final_answer",
        input_tokens: 1,
        output_tokens: 1,
      },
      "replay",
    );
    applyEvent(restored, { type: "run_ended", at: 3, status: "completed" }, "replay");
    restored.endReconcile();
    restored.complete();
    await settleSyntaxSurfaces(fixture.rendered);
    expect(fixture.scrollbox().content.findDescendantById(`transcript-row:${id}`)).toBe(row);
    expect(fixture.rendered.captureCharFrame()).toContain("FINAL ANSWER CORRECTED");
    expect(recorder.recordedFrames.length).toBeGreaterThan(3);
  } finally {
    recorder.stop();
    fixture.rendered.renderer.destroy();
  }
});

for (const latency of [10, 90, 500]) {
  test(`exploration identity does not depend on a ${latency} ms sibling interval`, async () => {
    const fixture = await openTranscript();
    const sink = fixture.store.openRun("timing");
    try {
      for (const event of transcriptToolEvents("first")) applyEvent(sink, event, "live");
      await fixture.frames();
      const id = fixture.history().snapshot().rowIds[0]!;
      const row = fixture.scrollbox().content.findDescendantById(`transcript-row:${id}`);
      await new Promise((resolve) => setTimeout(resolve, latency));
      for (const event of transcriptToolEvents("second", "grep")) applyEvent(sink, event, "live");
      await fixture.frames();
      expect(fixture.history().snapshot().rowIds).toEqual([id]);
      expect(fixture.scrollbox().content.findDescendantById(`transcript-row:${id}`)).toBe(row);
      expect(fixture.rendered.captureCharFrame()).toContain("2 tools");
    } finally {
      fixture.rendered.renderer.destroy();
    }
  });
}
