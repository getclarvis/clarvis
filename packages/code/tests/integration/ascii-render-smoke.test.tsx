import { afterEach, expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { Splash } from "../../src/views/Splash.tsx";
import { Footer } from "../../src/views/Footer.tsx";
import { applyAsciiMode } from "../../src/theme/glyphs.ts";

afterEach(() => applyAsciiMode(false));

test("ASCII mode renders representative brand and navigation surfaces without unicode", async () => {
  const t = await openRender(
    () => (
      <box width={90} height={28} flexDirection="column">
        <Splash agent={() => "coder"} model={() => "sonnet-4-5"} width={() => 90} />
        <Footer
          hint={() => ({ text: "", tone: "info" })}
          navigation={<text>[/] commands [ctrl+s] safety</text>}
        />
      </box>
    ),
    { width: 90, height: 28 },
  );
  try {
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("agent: coder · model: sonnet-4-5");

    applyAsciiMode(true);
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect([...frame].filter((character) => character.codePointAt(0)! > 0x7f)).toEqual([]);
    expect(frame).toContain("agent: coder . model: sonnet-4-5");
    expect(frame).toContain("[/] commands");
    expect(frame).toContain("[ctrl+s] safety");
  } finally {
    t.renderer.destroy();
  }
});
