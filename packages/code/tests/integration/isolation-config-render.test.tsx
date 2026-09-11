import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { SettingsAdapter } from "../../src/adapters/settings.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { IsolationConfigPanel } from "../../src/views/config/IsolationConfigPanel.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function mount() {
  const { keymap, press } = createFakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const effective: Record<string, unknown> = {};
  const writes: Array<{ scope: string; patch: unknown }> = [];
  const notes: string[] = [];
  const sandboxOpened: true[] = [];
  const runtimeRetries: true[] = [];
  const settings = {
    version: () => writes.length,
    effective: () => effective,
    read: (scope: "global" | "workspace") => (scope === "global" ? effective : undefined),
    write: async (scope: string, patch: unknown) => {
      writes.push({ scope, patch });
      Object.assign(effective, patch as object);
    },
  } as unknown as SettingsAdapter;
  const deps = {
    settings,
    notify: (message: string) => notes.push(message),
    runActive: () => false,
    openSandbox: () => sandboxOpened.push(true),
    retryRuntime: () => runtimeRetries.push(true),
  };
  return { host, deps, press, writes, notes, sandboxOpened, runtimeRetries };
}

test("Isolation settings persist a simple Podman runtime globally", async () => {
  const { host, deps, press, writes, notes, sandboxOpened, runtimeRetries } = mount();
  const t = await openRender((() => IsolationConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Isolation");
  expect(frame).toContain("Container runtime");
  expect(frame).toContain("workspace settings cannot choose a runtime");
  expect(frame).toContain("[b] sandbox details");

  press("b");
  expect(sandboxOpened).toEqual([true]);
  press("return");
  await t.renderOnce();
  press("down");
  press("down");
  press("down");
  press("return");
  await tick();

  expect(writes).toEqual([
    {
      scope: "global",
      patch: {
        runtime: { backend: "podman" },
        sandbox: {
          type: "native",
          enabled: true,
          availability: "required",
          filesystem: "workspace-write",
          network: "host",
          toolchains: { mode: "auto" },
        },
      },
    },
  ]);
  expect(runtimeRetries).toEqual([true]);
  expect(notes).toEqual(["isolation: podman (global)"]);
  t.renderer.destroy();
});
