import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { rgbToHex } from "@opentui/core";
import { AgentProfilePicker } from "../../src/views/overlays/AgentProfilePicker.tsx";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { AgentProfileView } from "../../src/adapters/agents.ts";
import { overlayBg, selectionBg } from "../../src/theme/surfaces.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { createSignal } from "solid-js";
import type { Scope } from "@clarvis/protocol";
import type { AgentDefaults } from "../../src/views/overlays/AgentProfilePicker.tsx";

function fakeInteraction(): { interaction: Interaction; press: (key: string) => void } {
  const { keymap, press } = createFakeKeymap();
  return {
    interaction: {
      keymap,
      pushOverlayContext: () => {},
      popOverlayContext: () => {},
    } as unknown as Interaction,
    press,
  };
}

const PROFILES: AgentProfileView[] = [
  {
    name: "explorer",
    canSpawn: [],
    grants: ["read_workspace"],
  },
  {
    name: "coder",
    model: "openrouter/gpt",
    canSpawn: ["explorer"],
    grants: ["read_workspace", "edit_workspace", "run_commands"],
  },
];

async function mount(active = "coder") {
  const { interaction, press } = fakeInteraction();
  const confirmed: string[] = [];
  const defaulted: Array<[string, Scope]> = [];
  const cleared: Scope[] = [];
  const [defaults, setDefaults] = createSignal<AgentDefaults>({ global: "explorer" });
  const t = await openRender(
    (() => (
      <AgentProfilePicker
        interaction={interaction}
        list={() => PROFILES}
        active={() => active}
        defaults={defaults}
        onConfirm={(name) => confirmed.push(name)}
        onSetDefault={(name, scope) => {
          defaulted.push([name, scope]);
          setDefaults((current) => ({ ...current, [scope]: name }));
          return true;
        }}
        onClearDefault={(scope) => {
          cleared.push(scope);
          setDefaults((current) => {
            const next = { ...current };
            delete next[scope];
            return next;
          });
          return true;
        }}
      />
    )) as never,
    { width: 110, height: 20 },
  );
  await t.renderOnce();
  return { t, press, confirmed, defaulted, cleared };
}

test("rows show name, model, Lead and grant columns; the band spans the selected row", async () => {
  const { t } = await mount("coder");
  const frame = t.captureCharFrame();
  expect(frame).toContain("Select Agent Profile");
  expect(frame).toContain("explorer");
  expect(frame).toContain("openrouter/gpt");
  expect(frame).toContain("explorer · default");
  expect(frame).toContain("Current session agent");
  expect(frame).toContain("Lead");
  expect(frame).toContain("read edit exec");
  expect(frame).toContain("[s] set default");
  const spans = t.captureSpans();
  const band = selectionBg(overlayBg()).toLowerCase();
  const cellOf = (needle: string) =>
    spans.lines.flatMap((l) => l.spans).find((s) => s.text.includes(needle))!;
  expect(rgbToHex(cellOf("coder").bg).toLowerCase()).toBe(band);
  expect(rgbToHex(cellOf("openrouter/gpt").bg).toLowerCase()).toBe(band);
  expect(rgbToHex(cellOf("explorer").bg).toLowerCase()).not.toBe(band);
  t.renderer.destroy();
});

test("opens with the active agent selected; enter switches without changing defaults", async () => {
  const { t, press, confirmed, defaulted } = await mount("coder");
  press("return");
  expect(confirmed).toEqual(["coder"]);
  expect(defaulted).toEqual([]);
  t.renderer.destroy();
});

test("s opens an explicit scope chooser before saving a default", async () => {
  const { t, press, defaulted } = await mount("coder");
  press("s");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Set coder as default");
  expect(t.captureCharFrame()).toContain("Global");
  press("return");
  expect(defaulted).toEqual([["coder", "global"]]);
  t.renderer.destroy();
});

test("the scope chooser can set and clear a workspace override", async () => {
  const { t, press, defaulted, cleared } = await mount("coder");
  press("s");
  press("down");
  press("return");
  expect(defaulted).toEqual([["coder", "workspace"]]);

  press("s");
  press("x");
  expect(cleared).toEqual(["workspace"]);
  t.renderer.destroy();
});

test("a mouse press on a row selects and confirms that agent", async () => {
  const { t, confirmed } = await mount("coder");
  const lines = t.captureCharFrame().split("\n");
  const y = lines.findIndex((l) => l.includes("explorer"));
  const x = lines[y]!.indexOf("explorer");
  await t.mockMouse.click(x, y);
  expect(confirmed).toEqual(["explorer"]);
  t.renderer.destroy();
});
