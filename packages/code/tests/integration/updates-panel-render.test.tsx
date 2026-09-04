import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import type { Interaction } from "../../src/keys/interaction.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { UpdatesPanel } from "../../src/views/config/UpdatesPanel.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { openRender } from "../helpers/tracked-render.ts";

test("shows and toggles the global automatic version-check preference", async () => {
  const { keymap, press } = createFakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const [enabled, setEnabled] = createSignal(true);
  const writes: boolean[] = [];
  const notices: string[] = [];
  const t = await openRender(
    (() =>
      UpdatesPanel(host, {
        code: {
          updateCheckEnabled: enabled,
          writeUpdateCheckEnabled(value) {
            writes.push(value);
            setEnabled(value);
          },
        },
        notify: (message) => notices.push(message),
      })) as never,
    { width: 90, height: 18 },
  );

  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Automatic checks on");
  expect(t.captureCharFrame()).toContain("global across every workspace");

  press("return");
  await t.renderOnce();
  expect(writes).toEqual([false]);
  expect(notices).toEqual(["automatic version checks off"]);
  expect(t.captureCharFrame()).toContain("Automatic checks off");
  t.renderer.destroy();
});
