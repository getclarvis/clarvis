import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { Splash } from "../../src/views/Splash.tsx";

/**
 * A minimal reproduction of {@link import("../../src/views/PageFrame.tsx").PageFrame}'s
 * two-box shape (title row + content region) with the content region's `overflow`
 * prop parametrized, mirroring `transcript-region-clip.test.tsx`'s technique for
 * `TranscriptRegion`. The content region is squeezed and given an unwrapped
 * `<Splash>` child (no scrollbox) so an un-clipped region lets the wordmark's
 * `position: absolute` centring bleed to a negative `y` and paint over the title
 * row above it.
 */
async function squeezedPageFrame(overflow: "hidden" | "visible"): Promise<string[]> {
  const ui = (): unknown => (
    <box flexDirection="column" flexGrow={1}>
      <box height={1} flexShrink={0}>
        <text height={1}>{"HEADERHEADERHEADERHEADERHEADERHEADERHEADERHEADERHEADERHEADER"}</text>
      </box>
      <box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="column" overflow={overflow}>
        <Splash agent={() => "coder"} model={() => "acme/model-x"} width={() => 80} />
      </box>
    </box>
  );
  const t = await openRender(ui as never, { width: 80, height: 5 });
  await t.renderOnce();
  const out = t.captureCharFrame().split("\n");
  t.renderer.destroy();
  return out;
}

test("a squeezed PageFrame content region does not paint over the title row above it", async () => {
  const clipped = await squeezedPageFrame("hidden");
  expect(clipped[0]).toContain("HEADER");
  expect(clipped[0]!.replace(/HEADER/g, "").trim()).toBe("");
});

test("the same region without a clip is what lets the wordmark reach the title row", async () => {
  const leaked = await squeezedPageFrame("visible");
  const clipped = await squeezedPageFrame("hidden");
  expect(leaked[0]).not.toBe(clipped[0]);
});
