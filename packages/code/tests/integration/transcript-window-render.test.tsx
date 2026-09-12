import { expect, test } from "bun:test";
import { MouseEvent } from "@opentui/core";
import { applyEvent } from "../../src/adapters/store.ts";
import { openTranscript, transcriptRenderables } from "../helpers/transcript-render.tsx";
import { transcriptToolEvents } from "../helpers/transcript-fixtures.ts";

for (const count of [80, 81, 1001]) {
  test(`${count} rows use one bounded direct-child viewport with native culling`, async () => {
    const fixture = await openTranscript();
    try {
      for (let i = 0; i < count; i++) fixture.store.appendNotice(`NOTICE_${i}`);
      await fixture.frames();
      const owners = fixture
        .scrollbox()
        .content.getChildren()
        .filter((node) => node.id.startsWith("transcript-row:"));
      expect(owners).toHaveLength(count <= 80 ? count : 40);
      expect(fixture.scrollbox().viewportCulling).toBe(true);
      expect(fixture.scrollbox().stickyScroll).toBe(true);
      expect(fixture.rendered.captureCharFrame()).toContain(`NOTICE_${count - 1}`);
      expect(
        transcriptRenderables(fixture.rendered.renderer.root).filter(
          (node) => node.id === "transcript-viewport",
        ),
      ).toHaveLength(1);
    } finally {
      fixture.rendered.renderer.destroy();
    }
  });
}

test("wheel-up reveals one page on user intent and idle frames never rewind repeatedly", async () => {
  const fixture = await openTranscript();
  try {
    for (let i = 0; i < 120; i++) fixture.store.appendNotice(`WHEEL_${i}`);
    await fixture.frames();
    fixture.history().scrollBy(-10000);
    await fixture.frames();
    const box = fixture.scrollbox();
    box.processMouseEvent(
      new MouseEvent(box, {
        type: "scroll",
        button: 0,
        x: box.x + 2,
        y: box.y + 2,
        modifiers: { shift: false, alt: false, ctrl: false },
        scroll: { direction: "up", delta: 3 },
      }),
    );
    await fixture.frames();
    const start = fixture.history().snapshot().start;
    expect(start).toBeLessThan(80);
    await fixture.frames(20);
    expect(fixture.history().snapshot().start).toBe(start);
    expect(box.stickyScroll).toBe(false);
    expect(fixture.history().scrollBy(Infinity)).toBe("end");
    await fixture.frames();
    expect(box.stickyScroll).toBe(true);
    expect(fixture.rendered.captureCharFrame()).toContain("WHEEL_119");
  } finally {
    fixture.rendered.renderer.destroy();
  }
});

test("prepend plus concurrent append preserves row and viewport-relative offset", async () => {
  const fixture = await openTranscript();
  try {
    for (let i = 0; i < 120; i++) fixture.store.appendNotice(`PAGE_${i}`);
    await fixture.frames();
    fixture.history().scrollBy(-10000);
    await fixture.frames();
    const before = fixture.history().snapshot().reader;
    expect(before.mode).toBe("anchor");
    expect(fixture.history().requestEarlier()).toBe(true);
    fixture.store.appendNotice("CONCURRENT");
    await fixture.frames();
    expect(fixture.history().snapshot().reader).toEqual(before);
    expect(fixture.history().snapshot().activeRowIds.length).toBeLessThanOrEqual(80);
  } finally {
    fixture.rendered.renderer.destroy();
  }
});

test("sidebar width changes preserve the same reader row without stealing follow", async () => {
  const fixture = await openTranscript();
  try {
    for (let i = 0; i < 120; i++) fixture.store.appendNotice(`WIDTH_${i}`);
    await fixture.frames();
    fixture.history().scrollBy(-12);
    await fixture.frames();
    const before = fixture.history().snapshot().reader;
    fixture.setSplit(true);
    await fixture.frames(5);
    expect(fixture.history().snapshot().reader).toEqual(before);
    fixture.setSplit(false);
    await fixture.frames(5);
    expect(fixture.history().snapshot().reader).toEqual(before);
    fixture.resize(80, 24);
    await fixture.frames(5);
    expect(fixture.history().snapshot().reader).toEqual(before);
    fixture.resize(120, 32);
    await fixture.frames(5);
    expect(fixture.history().snapshot().reader).toEqual(before);
  } finally {
    fixture.rendered.renderer.destroy();
  }
});

test("a restored child without current activity retains its identity and a return-to-Lead action", async () => {
  const fixture = await openTranscript();
  try {
    fixture.store.appendNotice("LEAD_RESTORED");
    const sink = fixture.store.openRun("restored");
    applyEvent(
      sink,
      {
        type: "delegation_created",
        at: 0,
        delegation_id: "child",
        title: "Reader",
        task: "fixture",
      },
      "replay",
    );
    for (const event of transcriptToolEvents("read", "read_file", "child"))
      applyEvent(sink, event, "replay");
    await fixture.frames();
    fixture.setSplit(true);
    fixture.transcript.toggleSubagent("child");
    await fixture.frames(5);
    const lines = fixture.rendered.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Back to Lead"));
    expect(y).toBeGreaterThanOrEqual(0);
    expect(lines[y]).toContain("Reader");
    await fixture.rendered.mockMouse.click(lines[y]!.indexOf("Back to Lead") + 1, y);
    await fixture.frames(5);
    expect(fixture.transcript.selectedSubagent()).toBeNull();
    expect(fixture.rendered.captureCharFrame()).toContain("LEAD_RESTORED");
  } finally {
    fixture.rendered.renderer.destroy();
  }
});

test("100 Lead/child cycles restore independent anchors and leave only the selected tree mounted", async () => {
  const fixture = await openTranscript();
  try {
    const sink = fixture.store.openRun("children");
    for (let i = 0; i < 120; i++) fixture.store.appendNotice(`LEAD_${i}`);
    for (const child of ["A", "B", "C"]) {
      applyEvent(
        sink,
        { type: "delegation_created", at: 0, delegation_id: child, title: child, task: "fixture" },
        "live",
      );
      for (let i = 0; i < 50; i++)
        for (const event of transcriptToolEvents(`shared-${i}`, "shell", child))
          applyEvent(sink, event, "live");
    }
    await fixture.frames();
    fixture.history().scrollBy(-10);
    await fixture.frames();
    const lead = fixture.history().snapshot().reader;
    for (let cycle = 0; cycle < 100; cycle++) {
      fixture.transcript.toggleSubagent("A");
      await fixture.frames();
      expect(
        fixture
          .history()
          .snapshot()
          .rowIds.every((id) => id.includes("A")),
      ).toBe(true);
      fixture.transcript.toggleSubagent("B");
      fixture.transcript.toggleSubagent("C");
      fixture.transcript.toggleSubagent("C");
      await fixture.frames();
      expect(fixture.history().snapshot().reader).toEqual(lead);
      const indicator = fixture
        .scrollbox()
        .content.findDescendantById("transcript-reader-indicator");
      expect(indicator?.y).toBe(fixture.scrollbox().viewport.y);
      expect(
        transcriptRenderables(fixture.rendered.renderer.root).filter((node) =>
          node.id.startsWith("transcript-row:"),
        ).length,
      ).toBeLessThanOrEqual(80);
    }
    fixture.store.clear();
    await fixture.frames();
    expect(fixture.history().snapshot().rowIds).toHaveLength(0);
  } finally {
    fixture.rendered.renderer.destroy();
  }
});
