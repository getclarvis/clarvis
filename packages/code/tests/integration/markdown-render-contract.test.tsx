import { expect, test } from "bun:test";
import { MarkdownRenderable, type Renderable } from "@opentui/core";
import { createSignal } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import { FINAL_MARKDOWN_CAP, TAIL_PLAIN_CAP } from "../../src/core/transcript/segment.ts";
import { BlockView } from "../../src/views/blocks.tsx";
import type { NodeStatus, TranscriptNode } from "../../src/adapters/store.ts";
import { glyph } from "../../src/theme/glyphs.ts";
import { StableMarkdown } from "../../src/ui/patterns/stable-syntax.tsx";
import { SPINNER_FRAMES } from "../../src/views/spinner.ts";

type Harness = Awaited<ReturnType<typeof openRender>>;

function markdownRenderables(root: Renderable): MarkdownRenderable[] {
  const found: MarkdownRenderable[] = [];
  const visit = (node: Renderable): void => {
    if (node instanceof MarkdownRenderable) found.push(node);
    for (const child of node.getChildren()) visit(child as Renderable);
  };
  visit(root);
  return found;
}

async function settle(t: Harness, ready: (frame: string) => boolean): Promise<string> {
  let previous = "";
  let stable = 0;
  for (let frame = 0; frame < 80; frame += 1) {
    await new Promise((resolve) => setTimeout(resolve, 8));
    await t.renderOnce();
    const current = t.captureCharFrame();
    if (current === previous && ready(current)) {
      stable += 1;
      if (stable >= 3) return current;
    } else {
      previous = current;
      stable = 0;
    }
  }
  return t.captureCharFrame();
}

async function capture(node: TranscriptNode, height = 30): Promise<string> {
  const t = await openRender(() => <BlockView node={node} forceExpand={() => true} />, {
    width: 70,
    height,
  });
  try {
    return await settle(t, (frame) => frame.trim().length > 0);
  } finally {
    t.renderer.destroy();
  }
}

test("the real assistant renderer preserves mixed markdown and the oversized-tail fallback", async () => {
  const mixed = await capture({
    key: "mixed",
    kind: "assistant",
    status: "ok",
    text: [
      "### Report",
      "",
      "- first finding",
      "- second finding",
      "",
      "| Kind | Result |",
      "| --- | --- |",
      "| audit | clean |",
      "",
      "Done.",
    ].join("\n"),
  });
  expect(mixed).toContain("Report");
  expect(mixed).toContain("first finding");
  expect(mixed).toContain("audit");
  expect(mixed).toContain("Done.");
  expect(mixed).toContain("│");

  const giant = "```ts\n" + "const value = 1;\n".repeat(5000);
  expect(giant.length).toBeGreaterThan(TAIL_PLAIN_CAP);
  expect(giant.length).toBeGreaterThan(FINAL_MARKDOWN_CAP);
  const node = (status: NodeStatus): TranscriptNode => ({
    key: `giant:${status}`,
    kind: "assistant",
    status,
    text: giant,
  });
  const running = await capture(node("running"), 18);
  const settled = await capture(node("ok"), 18);
  expect(running).toContain("const value = 1;");
  expect(settled).toContain("Formatting simplified");
  expect(settled).toContain("const value = 1;");
});

test("released assistant prose renders the persisted-export recovery route", async () => {
  const rendered = await capture({
    key: "released",
    kind: "assistant",
    status: "ok",
    text: "Earlier transcript prose released. Reopen the session to reload it.",
    textTruncated: true,
    proseReleased: true,
  });
  expect(rendered).toContain("/export");
  expect(rendered).toContain("persisted transcript");
  expect(rendered).not.toContain("Reopen the session");
});

test("a streaming assistant keeps a static transcript marker", async () => {
  const rendered = await capture({
    key: "live-static-marker",
    kind: "assistant",
    status: "running",
    text: "Live Markdown response",
  });
  expect(rendered).toContain(`${glyph("bullet")} Live Markdown response`);
  for (const frame of SPINNER_FRAMES)
    expect(rendered).not.toContain(`${frame} Live Markdown response`);
});

test("a sealed heading stays visually stable while the streaming tail grows", async () => {
  const heading =
    "### Stable section\n\n" +
    Array.from(
      { length: 100 },
      (_, index) => `Closed paragraph ${index}: ${"x".repeat(40)}.\n\n`,
    ).join("");
  const [text, setText] = createSignal(heading);
  const [status, setStatus] = createSignal<NodeStatus>("running");
  const node = (): TranscriptNode => ({
    key: "stream",
    kind: "assistant",
    status: status(),
    text: text(),
  });
  const t = await openRender(() => <BlockView node={node()} forceExpand={() => true} />, {
    width: 60,
    height: 16,
  });
  try {
    const first = await settle(t, (frame) => frame.includes("Stable section"));
    const headingLine = (frame: string): string =>
      (frame.split("\n").find((line) => line.includes("Stable section")) ?? "").trimEnd();
    const stable = headingLine(first);
    expect(stable).toContain("Stable section");
    const sealed = markdownRenderables(t.renderer.root)[0];
    expect(sealed).toBeDefined();

    let buffer = heading;
    for (const delta of ["The ", "model ", "writes ", "below."]) {
      buffer += delta;
      setText(buffer);
      await t.renderOnce();
      expect(headingLine(t.captureCharFrame())).toBe(stable);
      expect(markdownRenderables(t.renderer.root)).toContain(sealed!);
    }

    setStatus("ok");
    await t.renderOnce();
    expect(markdownRenderables(t.renderer.root)).toContain(sealed!);
  } finally {
    t.renderer.destroy();
  }
});

test("settlement keeps the painted streaming markdown visible until its final tree is ready", async () => {
  const content = [
    "### Final report",
    "",
    "A paragraph with **strong text**.",
    "",
    "- one",
    "- two",
    "",
    "```ts",
    "const answer = 42;",
    "```",
  ].join("\n");
  const [status, setStatus] = createSignal<NodeStatus>("running");
  const node = (): TranscriptNode => ({
    key: "settlement",
    kind: "assistant",
    status: status(),
    text: content,
  });
  const t = await openRender(() => <BlockView node={node()} forceExpand={() => true} />, {
    width: 70,
    height: 20,
  });
  try {
    const streamed = await settle(t, (frame) => frame.includes("const answer = 42;"));
    expect(streamed).toContain("Final report");
    const live = markdownRenderables(t.renderer.root);
    expect(live).toHaveLength(1);
    expect(live[0]!.opacity).toBe(1);

    setStatus("ok");
    await t.renderOnce();
    const transition = t.captureCharFrame();
    expect(transition).toContain("Final report");
    expect(transition).toContain("const answer = 42;");
    const preparing = markdownRenderables(t.renderer.root);
    expect(preparing.length).toBeGreaterThanOrEqual(1);
    expect(preparing.some((renderable) => renderable.opacity === 1)).toBe(true);

    const finalized = await settle(t, (frame) => frame.includes("const answer = 42;"));
    expect(finalized).toContain("Final report");
    const finalTrees = markdownRenderables(t.renderer.root);
    expect(finalTrees).toHaveLength(1);
    expect(finalTrees[0]!.opacity).toBe(1);
  } finally {
    t.renderer.destroy();
  }
});

test("settlement releases a streaming height floor after the final tree is ready", async () => {
  const unfinished = "aaaaaaaaaaaaaa **bol";
  const [streaming, setStreaming] = createSignal(true);
  const [content, setContent] = createSignal(unfinished);
  const t = await openRender(
    () => <StableMarkdown content={content()} streaming={streaming()} conceal />,
    {
      width: 19,
      height: 10,
    },
  );
  try {
    await settle(t, (frame) => frame.includes("bol"));
    const initialMarkdown = markdownRenderables(t.renderer.root)[0];
    const owner = initialMarkdown?.parent?.parent;
    if (owner === undefined || owner === null)
      throw new Error("stable Markdown owner did not mount");
    const streamingRows = owner.height;
    expect(streamingRows).toBe(2);

    setContent("aaaaaaaaaaaaaa **bold");
    await t.renderOnce();
    const unfinishedRows = owner.height;
    setContent("aaaaaaaaaaaaaa **bold**");
    await t.renderOnce();
    const concealedRows = owner.height;
    expect([streamingRows, unfinishedRows, concealedRows]).toEqual([2, 2, 2]);
    setStreaming(false);
    for (let pass = 0; pass < 80 && owner.height > 2; pass += 1) {
      await new Promise((resolve) => setTimeout(resolve, 8));
      await t.renderOnce();
    }

    expect(owner.height).toBeLessThanOrEqual(2);
  } finally {
    t.renderer.destroy();
  }
});

test("a tall streaming reply does not leave blank rows above the run outcome", async () => {
  const unfinished = Array.from(
    { length: 16 },
    (_, index) => `Streaming paragraph ${index} with **unclosed`,
  ).join("\n\n");
  const [status, setStatus] = createSignal<NodeStatus>("running");
  const [text, setText] = createSignal(unfinished);
  const assistant = (): TranscriptNode => ({
    key: "final-answer",
    kind: "assistant",
    status: status(),
    text: text(),
  });
  const outcome: TranscriptNode = {
    key: "run",
    kind: "run",
    status: "ok",
    text: "",
  };
  const t = await openRender(
    () => (
      <box flexDirection="column">
        <BlockView node={assistant()} forceExpand={() => true} />
        <BlockView node={outcome} forceExpand={() => true} />
      </box>
    ),
    { width: 48, height: 36 },
  );
  try {
    await settle(t, (frame) => frame.includes("Streaming paragraph 15"));
    setText("Short final answer.");
    setStatus("ok");
    const settled = await settle(
      t,
      (frame) => frame.includes("Short final answer.") && frame.includes("Completed"),
    );
    const lines = settled.split("\n");
    const bullet = lines.findIndex((line) => line.includes(glyph("bullet")));
    const completed = lines.findIndex((line) => line.includes("Completed"));
    expect(settled).toContain("Short final answer.");
    expect(bullet).toBeGreaterThanOrEqual(0);
    expect(completed).toBeGreaterThan(bullet);
    expect(completed - bullet).toBeLessThanOrEqual(4);
  } finally {
    t.renderer.destroy();
  }
});
