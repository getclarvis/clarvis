import { expect, test } from "bun:test";
import { MarkdownRenderable, type Renderable } from "@opentui/core";
import { createSignal } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import { FINAL_MARKDOWN_CAP, TAIL_PLAIN_CAP } from "../../src/core/transcript/segment.ts";
import { BlockView } from "../../src/views/blocks.tsx";
import type { NodeStatus, TranscriptNode } from "../../src/adapters/store.ts";
import { glyph } from "../../src/theme/glyphs.ts";
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
