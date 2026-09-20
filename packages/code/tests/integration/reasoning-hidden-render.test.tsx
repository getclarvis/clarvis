import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import { BlockView } from "../../src/views/blocks.tsx";
import { thinkingPreview } from "../../src/views/truncate.ts";
import type { FoldFixtureNode } from "../helpers/transcript-fixtures.ts";

function reasoning(text: string, collapsed: boolean): FoldFixtureNode {
  return { key: "r0", kind: "reasoning", status: collapsed ? "ok" : "running", text, collapsed };
}

test("thinking preview preserves graphemes and bounds unbroken words by terminal cells", () => {
  expect(thinkingPreview("abcdefghi", 3)).toBe("abc\ndef\nghi");
  expect(thinkingPreview("abcdefghij", 3)).toBe("abc\ndef\n...");
  const preview = thinkingPreview("👩‍💻界é".repeat(20), 10);
  expect(preview.split("\n")).toHaveLength(3);
  expect(preview).toEndWith("...");
  for (const line of preview.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(10);
});

async function frame(node: FoldFixtureNode, opts: { expand?: boolean } = {}): Promise<string> {
  const t = await openRender(
    () => (
      <BlockView
        node={node}
        defaultFolded={() => node.collapsed ?? false}
        forceExpand={() => opts.expand ?? false}
      />
    ),
    { width: 100, height: 30 },
  );
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

test("a collapsed reasoning node renders nothing — no `thinking` spark", async () => {
  const out = await frame(reasoning("The user is asking me to verify the app", true));
  expect(out).not.toContain("thinking");
  expect(out).not.toContain("The user is asking me to verify");
});

test("reasoning still streaming (not collapsed) shows its label and text", async () => {
  const out = await frame(reasoning("Let me look at the source files", false));
  expect(out).toContain("thinking");
  expect(out).toContain("Let me look at the source files");
});

test("reasoning normalizes Markdown chrome without changing its words", async () => {
  const out = await frame(
    reasoning(
      "**Designing createLocalContainerRuntime test****Planning RuntimeHostInput deprecation test**",
      false,
    ),
  );
  expect(out).toContain(
    "Designing createLocalContainerRuntime test Planning RuntimeHostInput deprecation test",
  );
  expect(out).not.toContain("**");
});

test("Ctrl+O force-expands a collapsed reasoning node back into view", async () => {
  const out = await frame(reasoning("As duas apps compilam", true), { expand: true });
  expect(out).toContain("thinking");
  expect(out).toContain("As duas apps compilam");
});

test("reasoning ends its third visible line with an ellipsis when more text remains", async () => {
  const out = await frame(reasoning("First\nSecond\nThird\nFourth hidden", false));
  expect(out).toContain("First");
  expect(out).toContain("Second");
  expect(out).toContain("Third...");
  expect(out).not.toContain("Fourth hidden");
});

test("reasoning keeps three visible lines across wrapping, resize and streaming updates", async () => {
  const [text, setText] = createSignal("one two three four five six seven eight nine ".repeat(8));
  const t = await openRender(() => <BlockView node={reasoning(text(), false)} />, {
    width: 40,
    height: 12,
  });
  try {
    for (const width of [40, 25, 100]) {
      t.resize(width, 12);
      await t.renderOnce();
      await t.renderOnce();
      const lines = t
        .captureCharFrame()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      expect(lines).toHaveLength(4);
      expect(lines[3]).toEndWith("...");
    }
    setText("First\nSecond\nThird");
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("Third");
    expect(t.captureCharFrame()).not.toContain("...");
    setText("First\nSecond\nThird\nFourth");
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("Third...");
    expect(t.captureCharFrame()).not.toContain("Fourth");
  } finally {
    t.renderer.destroy();
  }
});
