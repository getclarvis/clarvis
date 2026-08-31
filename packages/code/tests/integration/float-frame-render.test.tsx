import { expect, test } from "bun:test";
import { useTerminalDimensions } from "@opentui/solid";
import { openRender } from "../helpers/tracked-render.ts";
import { FloatFrame } from "../../src/views/overlays/FloatFrame.tsx";
import { HintToast } from "../../src/views/Footer.tsx";
import { ProfilePicker } from "../../src/views/overlays/ProfilePicker.tsx";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { AgentProfileView } from "../../src/adapters/agents.ts";

const stubInteraction = {
  keymap: { registerLayer: () => () => {} },
} as unknown as Interaction;

async function frame(ui: () => unknown, width = 100, height = 24): Promise<string[]> {
  const t = await openRender(ui as never, { width, height });
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out.split("\n");
}

test("FloatFrame renders a centered bordered panel over a backdrop scrim", async () => {
  const rows = await frame(() => (
    <box width={100} height={24}>
      <text>BEHIND THE PANEL</text>
      <FloatFrame title="Pick one" footer="Esc closes">
        <text>row content</text>
      </FloatFrame>
    </box>
  ));
  const top = rows.find((r) => r.includes("╭"));
  const bottom = rows.find((r) => r.includes("╰"));
  expect(top).toBeDefined();
  expect(bottom).toBeDefined();
  const left = top!.indexOf("╭");
  const right = top!.lastIndexOf("╮");
  expect(right - left + 1).toBeLessThanOrEqual(85);
  expect(left).toBeGreaterThan(4);
  expect(rows.some((r) => r.includes("BEHIND THE PANEL"))).toBe(false);
  expect(rows.some((r) => r.includes("Pick one"))).toBe(true);
  expect(rows.some((r) => r.includes("row content"))).toBe(true);
  expect(rows.some((r) => r.includes("Esc closes"))).toBe(true);
});

test("FloatFrame resolves a JSX navigation prop into one responsive subtree", async () => {
  let mounts = 0;
  const NavigationProbe = () => {
    mounts += 1;
    const dimensions = useTerminalDimensions();
    return <text>{`width ${dimensions().width}`}</text>;
  };
  const t = await openRender(
    () => (
      <FloatFrame title="One navigation" navigation={<NavigationProbe />}>
        <text>row content</text>
      </FloatFrame>
    ),
    { width: 100, height: 24 },
  );

  await t.renderOnce();
  expect(mounts).toBe(1);
  expect(t.renderer.listenerCount("resize")).toBe(2);
  t.renderer.destroy();
  expect(t.renderer.listenerCount("resize")).toBe(0);
});

test("a notify with a picker open survives the scrim: footer row buried, HintToast on top", async () => {
  const rows = await frame(() => (
    <box width={100} height={24} flexDirection="column">
      <box flexGrow={1} />
      <text>footer hint row</text>
      <FloatFrame title="Resume session" footer="[esc] close">
        <text>row content</text>
      </FloatFrame>
      <HintToast hint={() => ({ text: "close the current overlay first ([esc])", tone: "warn" })} />
    </box>
  ));
  expect(rows.some((r) => r.includes("footer hint row"))).toBe(false);
  const toastRow = rows.findIndex((r) => r.includes("close the current overlay first ([esc])"));
  expect(toastRow).toBe(23); // bottom-anchored: the screen's last row, where the hint line lives
});

test("an empty hint renders no toast row over the dialog", async () => {
  const rows = await frame(() => (
    <box width={100} height={24}>
      <FloatFrame title="Resume session" footer="[esc] close">
        <text>row content</text>
      </FloatFrame>
      <HintToast hint={() => ({ text: "", tone: "info" })} />
    </box>
  ));
  expect(rows.some((r) => r.includes("[esc] close"))).toBe(true);
  expect(rows[23]!.trim()).toBe("");
});

function cardBounds(rows: string[]): { width: number; height: number } {
  const topIdx = rows.findIndex((r) => r.includes("╭"));
  const bottomIdx = rows.findIndex((r) => r.includes("╰"));
  const top = rows[topIdx]!;
  return {
    width: top.lastIndexOf("╮") - top.indexOf("╭") + 1,
    height: bottomIdx - topIdx + 1,
  };
}

test("size='sm' renders the compact GuardPicker-style card", async () => {
  const rows = await frame(
    () => (
      <box width={120} height={30}>
        <FloatFrame title="Small" footer="footer" size="sm">
          {Array.from({ length: 20 }, (_, i) => (
            <text>{`row ${i}`}</text>
          ))}
        </FloatFrame>
      </box>
    ),
    120,
    30,
  );
  const card = cardBounds(rows);
  expect(card.width).toBe(80);
  expect(card.height).toBeLessThanOrEqual(10);
});

test("a card hugs definite-height children instead of stretching to the ceiling", async () => {
  const rows = await frame(
    () => (
      <box width={120} height={30}>
        <FloatFrame title="Short" footer="footer">
          <text>one</text>
          <text>two</text>
        </FloatFrame>
      </box>
    ),
    120,
    30,
  );
  expect(cardBounds(rows).height).toBe(7);
});

test("the default lg recipe clamps a tall card at 80% of the screen", async () => {
  const rows = await frame(
    () => (
      <box width={120} height={30}>
        <FloatFrame title="Tall" footer="footer">
          {Array.from({ length: 40 }, (_, i) => (
            <text>{`row ${i}`}</text>
          ))}
        </FloatFrame>
      </box>
    ),
    120,
    30,
  );
  const card = cardBounds(rows);
  expect(card.width).toBe(100);
  expect(card.height).toBeLessThanOrEqual(24);
});

test("minWidth keeps a narrow-terminal card readable instead of 85% of nothing", async () => {
  const rows = await frame(
    () => (
      <box width={44} height={20}>
        <FloatFrame title="Narrow" footer="footer">
          <text>row content</text>
        </FloatFrame>
      </box>
    ),
    44,
    20,
  );
  expect(cardBounds(rows).width).toBe(40);
});

test("explicit dimension props still override the recipe", async () => {
  const rows = await frame(
    () => (
      <box width={120} height={30}>
        <FloatFrame title="Custom" footer="footer" width={50} maxWidth={50}>
          <text>row content</text>
        </FloatFrame>
      </box>
    ),
    120,
    30,
  );
  expect(cardBounds(rows).width).toBe(50);
});

test("the agent picker renders its rows inside the floating panel", async () => {
  const list = [
    { name: "coder", model: "sonnet-4-5", grants: [], canSpawn: [] },
    { name: "explorer", grants: [], canSpawn: [] },
  ] as unknown as AgentProfileView[];
  const rows = await frame(() => (
    <box width={100} height={24}>
      <ProfilePicker
        interaction={stubInteraction}
        list={() => list}
        active={() => "coder"}
        defaults={() => ({})}
        onConfirm={() => {}}
        onSetDefault={() => true}
        onClearDefault={() => true}
      />
    </box>
  ));
  expect(rows.some((r) => r.includes("Select agent"))).toBe(true);
  expect(rows.some((r) => r.includes("coder"))).toBe(true);
  expect(rows.some((r) => r.includes("explorer"))).toBe(true);
  expect(rows.some((r) => r.includes("╭"))).toBe(true);
});
