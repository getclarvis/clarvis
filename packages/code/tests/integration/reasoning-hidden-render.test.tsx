import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { BlockView } from "../../src/views/blocks.tsx";
import type { SectionHeader } from "../../src/views/subagent-sections.ts";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import type { LegacyCollapsibleNode } from "../helpers/transcript-fixtures.ts";

function reasoning(text: string, collapsed: boolean): LegacyCollapsibleNode {
  return { key: "r0", kind: "reasoning", status: collapsed ? "ok" : "running", text, collapsed };
}

async function frame(
  node: TranscriptNode,
  opts: { expand?: boolean; header?: SectionHeader } = {},
): Promise<string> {
  const t = await openRender(
    () => (
      <BlockView
        node={node}
        forceExpand={() => opts.expand ?? false}
        sectionHeader={opts.header ? () => opts.header : undefined}
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

test("Ctrl+O force-expands a collapsed reasoning node back into view", async () => {
  const out = await frame(reasoning("As duas apps compilam", true), { expand: true });
  expect(out).toContain("thinking");
  expect(out).toContain("As duas apps compilam");
});

test("hiding the collapsed reasoning body keeps the subagent section header", async () => {
  const header: SectionHeader = {
    order: 0,
    title: "subagent",
    model: "zai-org/GLM-5.2",
    status: "running",
  };
  const out = await frame(reasoning("thinking to itself", true), { header });
  expect(out).toContain("Subagent");
  expect(out).toContain("zai-org/GLM-5.2");
  expect(out).not.toContain("thinking to itself");
});
