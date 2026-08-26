import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { SafetyPresetPicker } from "../../src/views/overlays/SafetyPresetPicker.tsx";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { SettingsAdapter } from "../../src/adapters/settings.ts";
import type { GuardModeStore } from "../../src/adapters/guard-mode.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("the quick picker confirms judged mode and applies the shared preset contract", async () => {
  const { keymap, press } = createFakeKeymap();
  const writes: Array<{ scope: string; patch: unknown }> = [];
  const guardModes: string[] = [];
  const notices: string[] = [];
  const applied: true[] = [];
  const settings = {
    effective: () => ({
      guard: { type: "shell", mode: "auto" as const, allowed_commands: ["git status"] },
      sandbox: {
        type: "bubblewrap" as const,
        enabled: true,
        availability: "required" as const,
        filesystem: "workspace-write" as const,
        network: "host" as const,
        toolchains: { mode: "auto" as const },
      },
    }),
    read: () => ({ guard: { type: "shell", allowed_commands: ["git status"] } }),
    write: async (scope: string, patch: unknown) => {
      writes.push({ scope, patch });
    },
  } as unknown as SettingsAdapter;
  const guard = {
    mode: () => "auto" as const,
    setMode: (mode: string) => guardModes.push(mode),
    cycle: () => "auto" as const,
  } as unknown as GuardModeStore;
  const interaction = {
    keymap,
    pushOverlayContext: () => {},
    popOverlayContext: () => {},
  } as unknown as Interaction;
  const rendered = await openRender(
    (() => (
      <SafetyPresetPicker
        interaction={interaction}
        settings={settings}
        guard={guard}
        scope={() => "global"}
        runActive={() => true}
        active={() => true}
        notify={(message) => notices.push(message)}
        onClose={() => {}}
        onApplied={() => applied.push(true)}
      />
    )) as never,
    { width: 110, height: 24 },
  );
  await rendered.renderOnce();

  const frame = rendered.captureCharFrame();
  expect(frame).toContain("Select safety preset");
  expect(frame).toContain("judged");
  expect(frame).toContain("LLM judge reviews risk");

  press("home");
  press("down");
  press("return");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Judged mode runs commands directly on the host");
  expect(writes).toEqual([]);

  press("y");
  await tick();
  expect(writes).toEqual([
    {
      scope: "global",
      patch: {
        guard: {
          allowed_commands: ["git status"],
          type: "shell",
          mode: "auto",
        },
        sandbox: {
          type: "bubblewrap",
          enabled: false,
          availability: "required",
          filesystem: "workspace-write",
          network: "host",
          toolchains: { mode: "auto" },
        },
      },
    },
  ]);
  expect(guardModes).toEqual(["auto"]);
  expect(notices).toEqual(["safety: judged (global) — applies to the next run"]);
  expect(applied).toEqual([true]);
  rendered.renderer.destroy();
});
