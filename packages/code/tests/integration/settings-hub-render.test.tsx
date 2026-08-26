import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { ITEMS, SettingsHub } from "../../src/views/config/SettingsHub.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const fakeKeymap = createFakeKeymap;

function mount() {
  const { keymap, press } = fakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const opened: string[] = [];
  return { host, press, opened, openChild: (cmd: string) => opened.push(cmd) };
}

// Driven from ITEMS rather than a written-out list: the hand-maintained version
// asserted eight of the nine destinations for as long as `Keyboard` had existed,
// so the count in its own title was the only thing that noticed.
test("lists every settings destination ITEMS declares", async () => {
  const { host, openChild } = mount();
  const t = await openRender((() => SettingsHub(host, { openChild })) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(ITEMS.length).toBeGreaterThan(0);
  expect(ITEMS.filter((item) => !frame.includes(item.label)).map((item) => item.label)).toEqual([]);
  t.renderer.destroy();
});

test("activating the selected row opens its command", async () => {
  const { host, press, opened } = mount();
  const t = await openRender(
    (() => SettingsHub(host, { openChild: (cmd) => opened.push(cmd) })) as never,
    { width: 110, height: 24 },
  );
  await t.renderOnce();
  await t.renderOnce();
  press("return");
  expect(opened).toEqual(["providers.open"]);
  press("down");
  press("return");
  expect(opened).toEqual(["providers.open", "capability-providers.open"]);
  t.renderer.destroy();
});
