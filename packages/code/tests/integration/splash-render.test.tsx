import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { BootFrame } from "../../src/views/BootFrame.tsx";
import { BANNER, Splash } from "../../src/views/Splash.tsx";

async function frame(width: number, height = 24): Promise<string> {
  const t = await openRender(
    () => (
      <box width={width} height={height}>
        <Splash agent={() => "coder"} model={() => "sonnet-4-5"} width={() => width} />
      </box>
    ),
    { width, height },
  );
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

test("the splash shows the banner, agent/model line and hints at 80 cols", async () => {
  const out = await frame(80);
  expect(out).toContain(".d8888b.");
  expect(out).toContain("agent: coder · model: sonnet-4-5");
  expect(out).toContain("Type / for commands");
  expect(out).toContain("@ for workspace files");
  expect(out).toContain("Shift+Tab for agents");
});

test("under 60 cols the banner falls back to the one-line wordmark", async () => {
  const out = await frame(50);
  expect(out).not.toContain(".d8888b.");
  expect(out).toContain("C L A R V I S");
});

test("the banner art is 8 rows and fits 60 cols", () => {
  expect(BANNER.length).toBe(8);
  for (const line of BANNER) expect(line.length).toBeLessThan(60);
});

test("the parser-free boot frame fills the terminal while startup modules load", async () => {
  const t = await openRender(() => <BootFrame />, { width: 48, height: 12 });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Clarvis · starting");
  t.renderer.destroy();
});
