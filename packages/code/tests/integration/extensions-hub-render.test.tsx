import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { ExtensionsHub } from "../../src/views/config/ExtensionsHub.tsx";
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
  return { host, press, opened };
}

test("lists Plugins, Hooks, Marketplace and MCP", async () => {
  const { host, opened } = mount();
  const t = await openRender(
    (() => ExtensionsHub(host, { openChild: (cmd) => opened.push(cmd) })) as never,
    { width: 110, height: 24 },
  );
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Plugins");
  expect(frame).toContain("Hooks");
  expect(frame).toContain("Marketplace");
  expect(frame).toContain("MCP");
  t.renderer.destroy();
});

test("activating a row opens its command", async () => {
  const { host, press, opened } = mount();
  const t = await openRender(
    (() => ExtensionsHub(host, { openChild: (cmd) => opened.push(cmd) })) as never,
    { width: 110, height: 24 },
  );
  await t.renderOnce();
  await t.renderOnce();
  press("down");
  press("return");
  expect(opened).toEqual(["hooks.open"]);
  t.renderer.destroy();
});
