import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { BlockView } from "../../src/views/blocks.tsx";
import { Prose } from "../../src/views/Prose.tsx";
import { scrollbarOptions, SCROLLBOX_TABLE_GUTTER } from "../../src/theme/surfaces.ts";
import type { TranscriptNode } from "../../src/adapters/store.ts";

const WIDE_TABLE = [
  "Texto introdutorio antes da tabela para dar contexto ao leitor.",
  "",
  "| Coluna A | Coluna B bem longa aqui | Coluna C com muito texto extra |",
  "| --- | --- | --- |",
  "| alpha | um texto razoavelmente comprido aqui | detalhe que estoura a largura 表意文字 |",
  "| beta | outro valor moderadamente longo demais | mais um detalhe grande que enche 😀😀 |",
].join("\n");

const FILLER = Array.from({ length: 16 }, (_, i) => `linha ${i} de contexto anterior`).join("\n");

function rightEdges(frame: string): { border: number; bar: number } {
  let border = -1;
  let bar = -1;
  for (const row of frame.split("\n")) {
    for (const ch of ["┘", "┐", "│", "┤", "┬", "┴"]) border = Math.max(border, row.lastIndexOf(ch));
    for (const ch of ["█", "▀", "▄", "░", "▒", "▓"]) bar = Math.max(bar, row.lastIndexOf(ch));
  }
  return { border, bar };
}

async function paint(ui: () => unknown, width: number): Promise<string> {
  const t = await openRender(ui as never, { width, height: 20 });
  await t.renderOnce();
  await t.flush();
  await t.waitForVisualIdle({ quietFrames: 6, maxFrames: 400 }).catch(() => {});
  await t.flush();
  const frame = t.captureCharFrame();
  t.renderer.destroy();
  return frame;
}

function expectTableClearsScrollbar(frame: string): void {
  const { border, bar } = rightEdges(frame);
  expect(border).toBeGreaterThan(0); // the table drew a real, unclipped right border
  expect(bar).toBeGreaterThan(border); // the scrollbar track sits to its right
  expect(bar - border).toBeGreaterThanOrEqual(2); // with >= 1 blank column between
  expect(frame.includes("?")).toBe(false); // no glyph severed at the boundary
}

test("the shared gutter reserves a column beside the scrollbar track", () => {
  expect(SCROLLBOX_TABLE_GUTTER).toBeGreaterThanOrEqual(2);
});

test("a wide table in the transcript keeps a blank column before the scrollbar", async () => {
  const node: TranscriptNode = {
    key: "a1",
    kind: "assistant",
    status: "ok",
    text: `${FILLER}\n\n${WIDE_TABLE}`,
  };
  for (const width of [60, 72]) {
    const frame = await paint(
      () => (
        <scrollbox
          flexGrow={1}
          stickyScroll
          stickyStart="bottom"
          paddingLeft={1}
          paddingRight={SCROLLBOX_TABLE_GUTTER}
          contentOptions={{ alignItems: "flex-start" }}
          verticalScrollbarOptions={scrollbarOptions()}
        >
          <BlockView node={node} />
        </scrollbox>
      ),
      width,
    );
    expectTableClearsScrollbar(frame);
  }
});

test("a wide table in a plan/memory document keeps a blank column before the scrollbar", async () => {
  for (const width of [60, 72]) {
    const frame = await paint(
      () => (
        <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingTop={1}>
          <scrollbox
            flexGrow={1}
            stickyScroll
            stickyStart="bottom"
            paddingRight={SCROLLBOX_TABLE_GUTTER}
            verticalScrollbarOptions={scrollbarOptions()}
          >
            <Prose block content={`${FILLER}\n\n${WIDE_TABLE}`} />
          </scrollbox>
        </box>
      ),
      width,
    );
    expectTableClearsScrollbar(frame);
  }
});
