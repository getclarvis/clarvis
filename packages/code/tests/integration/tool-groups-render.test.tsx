import { expect, test } from "bun:test";
import { applyEvent } from "../../src/adapters/store.ts";
import { transcriptToolEvents } from "../helpers/transcript-fixtures.ts";
import { openTranscript, transcriptRenderables } from "../helpers/transcript-render.tsx";

test("shell calls and unknown MCP leaves remain individually accessible instead of joining exploration", async () => {
  const fixture = await openTranscript();
  const sink = fixture.store.openRun("individual");
  try {
    for (const id of ["a", "b"])
      for (const event of transcriptToolEvents(id, "shell")) applyEvent(sink, event, "live");
    for (const server of ["alpha", "beta"])
      applyEvent(
        sink,
        {
          type: "tool_call",
          at: 7,
          agent: "lead",
          call_id: server,
          server,
          tool: "read_file",
          arguments: {},
          result: "result",
          ok: false,
          error: "DENIED",
        },
        "live",
      );
    await fixture.frames();
    expect(fixture.history().snapshot().rowIds).toHaveLength(4);
    expect(
      fixture
        .history()
        .snapshot()
        .rowIds.some((id) => id.startsWith("exploration:")),
    ).toBe(false);
    expect(fixture.rendered.captureCharFrame()).toContain("alpha");
    expect(fixture.rendered.captureCharFrame()).toContain("beta");
  } finally {
    fixture.rendered.renderer.destroy();
  }
});

test("an exploration header transitions from active to settled wording", async () => {
  const fixture = await openTranscript();
  const sink = fixture.store.openRun("lifecycle");
  try {
    const events = transcriptToolEvents("call-0");
    for (const event of events.slice(0, -1)) applyEvent(sink, event, "live");
    await fixture.frames();
    expect(fixture.rendered.captureCharFrame()).toContain("Exploring · 1 tool");
    expect(fixture.rendered.captureCharFrame()).not.toContain(" active");

    applyEvent(sink, events.at(-1)!, "live");
    await fixture.frames();
    expect(fixture.rendered.captureCharFrame()).toContain("Explored · 1 tool");
    expect(fixture.rendered.captureCharFrame()).not.toContain("Exploring · 1 tool");
  } finally {
    fixture.rendered.renderer.destroy();
  }
});

test("a small failed exploration expands without a redundant failure shortcut", async () => {
  const fixture = await openTranscript();
  const sink = fixture.store.openRun("small-issues");
  try {
    for (let i = 0; i < 2; i++) {
      for (const event of transcriptToolEvents(`call-${i}`))
        applyEvent(
          sink,
          event.type === "tool_call" && i === 1
            ? { ...event, ok: false, error: "READ_FAILED" }
            : event,
          "live",
        );
    }
    await fixture.frames();
    expect(fixture.rendered.captureCharFrame()).toContain(
      "Explored · 2 tools · 1 failed/interrupted",
    );
    expect(fixture.rendered.captureCharFrame()).not.toContain("Show first failure");
    fixture.transcript.toggleAt(fixture.history().snapshot().rowIds[0]!);
    await fixture.frames();
    expect(fixture.rendered.captureCharFrame()).toContain("READ_FAILED");
    expect(
      transcriptRenderables(fixture.rendered.renderer.root).filter((node) =>
        node.id.startsWith("transcript-member:"),
      ),
    ).toHaveLength(2);
  } finally {
    fixture.rendered.renderer.destroy();
  }
});

test("a failed exploration member remains discoverable while folded and expansion is paginated", async () => {
  const fixture = await openTranscript();
  const sink = fixture.store.openRun("issues");
  try {
    for (let i = 0; i < 45; i++) {
      const events = transcriptToolEvents(`call-${i}`);
      for (const event of events)
        applyEvent(
          sink,
          event.type === "tool_call" && i === 44
            ? { ...event, ok: false, error: "READ_FAILED" }
            : event,
          "live",
        );
    }
    await fixture.frames();
    expect(fixture.rendered.captureCharFrame()).toContain("1 failed/interrupted");
    expect(fixture.rendered.captureCharFrame()).toContain("Show first failure");
    const id = fixture.history().snapshot().rowIds[0]!;
    fixture.transcript.toggleAt(id);
    await fixture.frames();
    expect(
      transcriptRenderables(fixture.rendered.renderer.root).filter((node) =>
        node.id.startsWith("transcript-member:"),
      ),
    ).toHaveLength(20);
    fixture.transcript.clearFocus();
    expect(fixture.transcript.focusBlock(-1)).toContain("call-19");
    fixture.transcript.toggleAt(id);
    await fixture.frames();
    const click = async (label: string) => {
      const lines = fixture.rendered.captureCharFrame().split("\n");
      const y = lines.findIndex((line) => line.includes(label));
      expect(y).toBeGreaterThanOrEqual(0);
      await fixture.rendered.mockMouse.click(lines[y]!.indexOf(label) + 1, y);
      await fixture.frames(5);
    };
    await click("Show first failure");
    expect(fixture.rendered.captureCharFrame()).toContain("READ_FAILED");
    expect(fixture.rendered.captureCharFrame()).toContain("41–45 / 45");
    expect(
      transcriptRenderables(fixture.rendered.renderer.root).filter((node) =>
        node.id.startsWith("transcript-member:"),
      ).length,
    ).toBe(5);
    await click("Previous");
    fixture.history().scrollBy(1000);
    await fixture.frames();
    expect(fixture.rendered.captureCharFrame()).toContain("21–40 / 45");
    expect(
      transcriptRenderables(fixture.rendered.renderer.root).filter((node) =>
        node.id.startsWith("transcript-member:"),
      ).length,
    ).toBe(20);
    await click("Next");
    expect(fixture.rendered.captureCharFrame()).toContain("41–45 / 45");
  } finally {
    fixture.rendered.renderer.destroy();
  }
});
