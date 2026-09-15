import { expect, test } from "bun:test";
import {
  MarkdownRenderable,
  TextAttributes,
  type Renderable,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { TestRecorder, type RecordedFrame } from "@opentui/core/testing";
import { createSignal } from "solid-js";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import { BlockView } from "../../src/views/blocks.tsx";
import { openRender } from "../helpers/tracked-render.ts";

function tokenCells(recorded: RecordedFrame, token: string, width: number) {
  const rows = recorded.frame.split("\n");
  const row = rows.findIndex((value) => value.includes(token));
  const column = row < 0 ? -1 : rows[row]!.indexOf(token);
  expect(row).toBeGreaterThanOrEqual(0);
  expect(column).toBeGreaterThanOrEqual(0);
  expect(recorded.buffers?.fg).toBeDefined();
  expect(recorded.buffers?.bg).toBeDefined();
  expect(recorded.buffers?.attributes).toBeDefined();
  const start = row * width + column;
  const end = start + token.length;
  return {
    row,
    column,
    fg: Array.from(recorded.buffers!.fg!.slice(start, end)),
    bg: Array.from(recorded.buffers!.bg!.slice(start, end)),
    attributes: Array.from(recorded.buffers!.attributes!.slice(start, end)),
  };
}

function markdownDescendants(root: Renderable): MarkdownRenderable[] {
  const result: MarkdownRenderable[] = [];
  const visit = (node: Renderable): void => {
    if (node instanceof MarkdownRenderable) result.push(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return result;
}

test("native sticky bottom follows streaming Markdown without a queued delta", async () => {
  const width = 22;
  const prefixes = [
    "aaaaaaaaaaaaaa **bol",
    "aaaaaaaaaaaaaa **bold",
    "aaaaaaaaaaaaaa **bold*",
    "aaaaaaaaaaaaaa **bold**",
    "aaaaaaaaaaaaaa **bold** xx",
  ];
  const [content, setContent] = createSignal(prefixes[0]!);
  const node = (): TranscriptNode => ({
    key: "streaming-markdown-height",
    kind: "assistant",
    status: "running",
    text: content(),
  });
  let scrollbox: ScrollBoxRenderable | undefined;
  const rendered = await openRender(
    () => (
      <scrollbox
        ref={(value: ScrollBoxRenderable) => (scrollbox = value)}
        height={6}
        width="100%"
        stickyScroll
        stickyStart="bottom"
        viewportCulling
        contentOptions={{ alignItems: "flex-start" }}
      >
        <box height={8} flexShrink={0}>
          <text wrapMode="none">
            {Array.from({ length: 8 }, (_, index) => `ANCHOR-${index}`).join("\n")}
          </text>
        </box>
        <BlockView node={node()} maxWidth="100%" forceExpand={() => true} />
      </scrollbox>
    ),
    { width, height: 8 },
  );
  try {
    if (scrollbox === undefined) throw new Error("native scrollbox did not mount");
    const mounted = scrollbox;
    await rendered.renderOnce();
    await rendered.renderOnce();

    const recorder = new TestRecorder(rendered.renderer, {
      recordBuffers: { fg: true, bg: true, attributes: true },
    });
    recorder.rec();
    await rendered.renderOnce();
    const baseline = recorder.recordedFrames.at(-1);
    if (baseline === undefined) throw new Error("baseline frame was not recorded");
    let previousAnchorRow = tokenCells(baseline, "ANCHOR-6", width).row;
    let previousScrollTop = mounted.scrollTop;
    const intrinsicRows = [markdownDescendants(mounted)[0]?.height];
    const scrollTops = [mounted.scrollTop];

    for (const prefix of prefixes.slice(1)) {
      recorder.clear();
      setContent(prefix);
      await rendered.renderOnce();
      await rendered.renderOnce();
      const frames = recorder.recordedFrames;
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        const anchorRow = tokenCells(frame, "ANCHOR-6", width).row;
        expect(anchorRow).toBeLessThanOrEqual(previousAnchorRow);
        previousAnchorRow = anchorRow;
      }
      expect(mounted.scrollTop).toBeGreaterThanOrEqual(previousScrollTop);
      previousScrollTop = mounted.scrollTop;
      intrinsicRows.push(markdownDescendants(mounted)[0]?.height);
      scrollTops.push(mounted.scrollTop);
    }

    expect(intrinsicRows).toEqual([2, 2, 2, 1, 2]);
    expect(scrollTops).toEqual([5, 5, 5, 5, 5]);

    const finalFrame = recorder.recordedFrames.at(-1);
    if (finalFrame === undefined) throw new Error("final Markdown frame was not recorded");
    const boldCells = tokenCells(finalFrame, "bold", width);
    expect(
      boldCells.attributes.every(
        (attributes) => (attributes & TextAttributes.BOLD) === TextAttributes.BOLD,
      ),
    ).toBe(true);
    expect(finalFrame.frame).not.toContain("**bold**");
  } finally {
    rendered.renderer.destroy();
  }
});
