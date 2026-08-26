import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { Splash } from "../../src/views/Splash.tsx";

/**
 * The transcript region squeezed to a few rows — what happens when the
 * slash-command popup expands the input dock, since this region is the only
 * child that can give the rows up. A header row is drawn above it so an
 * overflowing child has something recognisable to paint over.
 */
async function squeezedRegion(overflow: "hidden" | "visible"): Promise<string[]> {
  const ui = (): unknown => (
    <box flexDirection="column" flexGrow={1}>
      <text height={1} flexShrink={0}>
        {"HEADERHEADERHEADERHEADERHEADERHEADERHEADERHEADERHEADERHEADER"}
      </text>
      <box flexDirection="row" flexGrow={1} overflow={overflow}>
        <Splash agent={() => "coder"} model={() => "acme/model-x"} width={() => 80} />
      </box>
      <box height={12} flexShrink={0} />
    </box>
  );
  const t = await openRender(ui as never, { width: 80, height: 16 });
  await t.renderOnce();
  const out = t.captureCharFrame().split("\n");
  t.renderer.destroy();
  return out;
}

/**
 * `Splash` is `position: absolute` with `justifyContent: center`, so once the
 * region is shorter than the wordmark, centring puts the wordmark at a negative
 * `y` — above the terminal's first row. Whether that overflow was *visible*
 * used to depend on paint order, and opening a config view changes paint order
 * permanently: `OverlayRegion` renders the transcript as a `Switch` fallback,
 * so the region is unmounted and a **new** renderable is appended on close,
 * which then paints after the header. Clipping makes the overlap impossible
 * instead of order-dependent.
 */
test("a squeezed transcript region does not paint over the row above it", async () => {
  const clipped = await squeezedRegion("hidden");
  expect(clipped[0]).toContain("HEADER");
  expect(clipped[0]!.replace(/HEADER/g, "").trim()).toBe("");
});

test("the same region without a clip is what let the wordmark reach that row", async () => {
  const leaked = await squeezedRegion("visible");
  const clipped = await squeezedRegion("hidden");
  expect(leaked[0]).not.toBe(clipped[0]);
});
