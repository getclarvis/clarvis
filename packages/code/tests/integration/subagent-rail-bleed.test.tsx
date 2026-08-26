import { expect, test } from "bun:test";
import { For } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { openRender } from "../helpers/tracked-render.ts";
import { BlockView } from "../../src/views/blocks.tsx";
import { tokens } from "../../src/theme/tokens.ts";
import type { TranscriptNode } from "../../src/adapters/store.ts";

function subagentNodes(): TranscriptNode[] {
  return Array.from({ length: 10 }, (_, i) => ({
    key: "w" + i,
    kind: "user",
    status: "ok",
    text: "subagent body line " + String(i + 1).padStart(2, "0"),
    subagentOrder: 1,
  }));
}

async function scrolledTopRows(mask: boolean): Promise<string[]> {
  let scroll: ScrollBoxRenderable | undefined;
  const list = subagentNodes();
  const t = await openRender(
    () => (
      <box flexDirection="column" flexGrow={1} backgroundColor={tokens.bg}>
        <box
          height={1}
          flexShrink={0}
          paddingLeft={1}
          backgroundColor={mask ? tokens.bg : undefined}
          zIndex={mask ? 1 : undefined}
        >
          <text>HEADERHEADER</text>
        </box>
        <box
          height={1}
          flexShrink={0}
          border={["top"]}
          borderStyle="single"
          backgroundColor={mask ? tokens.bg : undefined}
          zIndex={mask ? 1 : undefined}
        />
        <box flexDirection="row" flexGrow={1}>
          <scrollbox
            ref={(el) => (scroll = el)}
            stickyScroll
            stickyStart="bottom"
            flexGrow={1}
            paddingLeft={1}
            paddingRight={1}
            contentOptions={{ alignItems: "flex-start" }}
          >
            <For each={list}>{(node) => <BlockView node={node} forceExpand={() => true} />}</For>
          </scrollbox>
        </box>
      </box>
    ),
    { width: 44, height: 8 },
  );
  await t.renderOnce();
  scroll?.scrollBy({ x: 0, y: 1_000_000 });
  await t.renderOnce();
  const rows = t.captureCharFrame().split("\n");
  t.renderer.destroy();
  return rows;
}

const RAIL = /[│|]/;

test("subagent rail does not bleed into the header/rule when scrolled past the top", async () => {
  const rows = await scrolledTopRows(true);
  expect(RAIL.test(rows[0] ?? "")).toBe(false);
  expect(RAIL.test(rows[1] ?? "")).toBe(false);
  const body = rows.slice(2).filter((r) => r.trim().length > 0);
  expect(body.some((r) => r.trimStart().startsWith("│"))).toBe(true);
});

test("blocks own their cells: no bleed above even without the header mask", async () => {
  const rows = await scrolledTopRows(false);
  expect(RAIL.test(rows[0] ?? "")).toBe(false);
  expect(RAIL.test(rows[1] ?? "")).toBe(false);
});
