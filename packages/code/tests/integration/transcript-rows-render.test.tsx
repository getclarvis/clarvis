import { expect, test } from "bun:test";
import { TestRecorder } from "@opentui/core/testing";
import { applyEvent } from "../../src/adapters/store.ts";
import {
  transcriptExplorationEvents,
  transcriptToolEvents,
} from "../helpers/transcript-fixtures.ts";
import { openTranscript, transcriptRenderables } from "../helpers/transcript-render.tsx";

test("one native row survives composition, pending, execution, terminal and next message", async () => {
  const fixture = await openTranscript();
  const sink = fixture.store.openRun("continuity");
  const recorder = new TestRecorder(fixture.rendered.renderer);
  recorder.rec();
  try {
    const events = transcriptToolEvents("call", "shell");
    applyEvent(sink, events[0]!, "live");
    await fixture.frames();
    const id = fixture.history().snapshot().activeRowIds[0]!;
    const wrapper = fixture.scrollbox().content.findDescendantById(`transcript-row:${id}`)!;
    const presenter = wrapper.findDescendantById(id);
    expect(wrapper).toBeDefined();
    expect(presenter).toBeDefined();
    for (const event of events.slice(1)) {
      applyEvent(sink, event, "live");
      await fixture.frames();
      expect(fixture.scrollbox().content.findDescendantById(`transcript-row:${id}`)).toBe(wrapper);
      expect(wrapper.isDestroyed).toBe(false);
      expect(wrapper.findDescendantById(id)).toBe(presenter);
    }
    applyEvent(sink, { type: "run_ended", at: 8, status: "completed" }, "live");
    sink.complete();
    fixture.store.appendUserMessage("NEXT_MESSAGE");
    await fixture.frames();
    expect(fixture.scrollbox().content.findDescendantById(`transcript-row:${id}`)).toBe(wrapper);
    expect(recorder.recordedFrames.length).toBeGreaterThan(4);
    expect(fixture.rendered.captureCharFrame()).toContain("NEXT_MESSAGE");
  } finally {
    recorder.stop();
    fixture.rendered.renderer.destroy();
  }
});

test("an expanded exploration retains visible members and limits 500 calls to 20 member owners", async () => {
  const fixture = await openTranscript();
  const sink = fixture.store.openRun("explore");
  try {
    for (const event of transcriptToolEvents("first")) applyEvent(sink, event, "live");
    await fixture.frames();
    const group = fixture.history().snapshot().activeRowIds[0]!;
    fixture.transcript.toggleAt(group);
    await fixture.frames();
    const first = transcriptRenderables(fixture.rendered.renderer.root).find((node) =>
      node.id.startsWith("transcript-member:"),
    )!;
    for (const event of transcriptExplorationEvents()) applyEvent(sink, event, "live");
    await fixture.frames();
    const members = transcriptRenderables(fixture.rendered.renderer.root).filter((node) =>
      node.id.startsWith("transcript-member:"),
    );
    expect(members).toHaveLength(20);
    expect(members[0]).toBe(first);
    for (let cycle = 0; cycle < 100; cycle++) {
      fixture.transcript.toggleAt(group);
      await fixture.frames(1);
      fixture.transcript.toggleAt(group);
      await fixture.frames(1);
    }
    expect(
      transcriptRenderables(fixture.rendered.renderer.root).filter((node) =>
        node.id.startsWith("transcript-member:"),
      ),
    ).toHaveLength(20);
  } finally {
    fixture.rendered.renderer.destroy();
  }
});

test("a reader away from the tail preserves its semantic row and screen offset across 100 appends", async () => {
  const fixture = await openTranscript();
  try {
    for (let row = 0; row < 120; row++) fixture.store.appendNotice(`ROW_${row}`);
    await fixture.frames();
    fixture.history().scrollBy(-12);
    await fixture.frames();
    const before = fixture.history().snapshot().reader;
    expect(before.mode).toBe("anchor");
    for (let row = 120; row < 220; row++) fixture.store.appendNotice(`ROW_${row}`);
    await fixture.frames();
    expect(fixture.history().snapshot().reader).toEqual(before);
    expect(fixture.history().snapshot().activeRowIds).toHaveLength(40);
    expect(fixture.history().diagnostics().newerEntries).toBeGreaterThanOrEqual(100);
    fixture.history().returnToTail();
    await fixture.frames();
    expect(fixture.rendered.captureCharFrame()).toContain("ROW_219");
  } finally {
    fixture.rendered.renderer.destroy();
  }
});
