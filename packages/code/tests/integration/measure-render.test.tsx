import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { BlockView, MEASURE_MAX_COLS } from "../../src/views/blocks.tsx";
import type { TranscriptNode } from "../../src/adapters/store.ts";

const longText = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");

test("transcript blocks cap at the reading measure on a wide terminal", async () => {
  const user: TranscriptNode = { key: "u", kind: "user", status: "ok", text: longText };
  const run: TranscriptNode = {
    key: "r",
    kind: "run",
    status: "ok",
    text: "",
    reason: "done",
    elapsedMs: 3_000,
  };
  const t = await openRender(
    () => (
      <scrollbox contentOptions={{ alignItems: "flex-start" }} paddingLeft={1} paddingRight={1}>
        <BlockView node={user} />
        <BlockView node={run} />
      </scrollbox>
    ),
    { width: 160, height: 20 },
  );
  await t.renderOnce();
  const rows = t.captureCharFrame().split("\n");
  t.renderer.destroy();
  const contentRows = rows.filter((r) => r.includes("word"));
  expect(contentRows.length).toBeGreaterThan(1);
  for (const row of rows) {
    expect(row.slice(MEASURE_MAX_COLS + 2, 158).trim()).toBe("");
  }
});

test("a split-pane transcript fills the space before its fixed sidebar", async () => {
  const user: TranscriptNode = { key: "u", kind: "user", status: "ok", text: longText };
  const sidebarWidth = 40;
  const sidebarLabel = "SIDEBAR";
  const t = await openRender(
    () => (
      <box flexDirection="row" width="100%">
        <scrollbox
          flexGrow={1}
          minWidth={0}
          contentOptions={{ alignItems: "flex-start" }}
          paddingLeft={1}
          paddingRight={1}
        >
          <BlockView node={user} fillAvailableWidth={() => true} />
        </scrollbox>
        <box width={sidebarWidth} flexShrink={0} border={["left"]}>
          <text>{sidebarLabel}</text>
        </box>
      </box>
    ),
    { width: 160, height: 20 },
  );
  await t.renderOnce();
  const rows = t.captureCharFrame().split("\n");
  t.renderer.destroy();

  const sidebarStart = rows.find((row) => row.includes(sidebarLabel))!.indexOf("│");
  const contentRows = rows.filter((row) => row.includes("word"));
  expect(sidebarStart).toBe(160 - sidebarWidth);
  expect(contentRows.some((row) => row.slice(MEASURE_MAX_COLS + 2, sidebarStart).trim())).toBe(
    true,
  );
  expect(contentRows.every((row) => !/word\d/.test(row.slice(sidebarStart + 1)))).toBe(true);
});
