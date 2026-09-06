import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { IsolationPicker } from "../../src/views/overlays/IsolationPicker.tsx";
import { ReviewPicker } from "../../src/views/overlays/ReviewPicker.tsx";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { SettingsAdapter } from "../../src/adapters/settings.ts";
import type { GuardModeStore } from "../../src/adapters/guard-mode.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function interactionWith(keymap: ReturnType<typeof createFakeKeymap>["keymap"]): Interaction {
  return {
    keymap,
    pushOverlayContext: () => {},
    popOverlayContext: () => {},
  } as unknown as Interaction;
}

test("the isolation picker selects minimal lazy Docker without changing review", async () => {
  const { keymap, press } = createFakeKeymap();
  const writes: Array<{ scope: string; patch: unknown }> = [];
  const notices: string[] = [];
  const applied: true[] = [];
  const retries: true[] = [];
  const effective = {
    guard: { type: "shell", mode: "auto" as const, allowed_commands: ["git status"] },
    sandbox: {
      type: "native" as const,
      enabled: true,
      availability: "required" as const,
      filesystem: "workspace-write" as const,
      network: "host" as const,
      toolchains: { mode: "auto" as const },
    },
  };
  const settings = {
    effective: () => effective,
    write: async (scope: string, patch: unknown) => {
      writes.push({ scope, patch });
      Object.assign(effective, patch as object);
    },
  } as unknown as SettingsAdapter;
  const rendered = await openRender(
    (() => (
      <IsolationPicker
        interaction={interactionWith(keymap)}
        settings={settings}
        runActive={() => true}
        active={() => true}
        retryRuntime={() => retries.push(true)}
        notify={(message) => notices.push(message)}
        onClose={() => {}}
        onApplied={() => applied.push(true)}
      />
    )) as never,
    { width: 110, height: 24 },
  );
  await rendered.renderOnce();

  const frame = rendered.captureCharFrame();
  expect(frame).toContain("Select isolation");
  expect(frame).toContain("Docker");
  expect(frame).toContain("starts on first run");

  press("down");
  press("return");
  await tick();
  expect(writes).toEqual([
    {
      scope: "global",
      patch: {
        runtime: { backend: "docker" },
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
  expect(retries).toEqual([true]);
  expect(notices).toEqual(["isolation: docker (global) — applies to the next run"]);
  expect(applied).toEqual([true]);
  rendered.renderer.destroy();
});

test("the review picker changes approval independently from isolation", async () => {
  const { keymap, press } = createFakeKeymap();
  const writes: Array<{ scope: string; patch: unknown }> = [];
  const modes: string[] = [];
  const notices: string[] = [];
  const effective = {
    runtime: { backend: "docker" as const },
    guard: { type: "shell" as const, mode: "off" as const, allowed_commands: ["git status"] },
  };
  const settings = {
    effective: () => effective,
    read: () => ({ guard: effective.guard }),
    write: async (scope: string, patch: unknown) => writes.push({ scope, patch }),
    validateProviders: () => ({ ok: true }),
  } as unknown as SettingsAdapter;
  const guard = {
    mode: () => "off" as const,
    setMode: (mode: string) => modes.push(mode),
  } as unknown as GuardModeStore;
  const rendered = await openRender(
    (() => (
      <ReviewPicker
        interaction={interactionWith(keymap)}
        settings={settings}
        guard={guard}
        scope={() => "workspace"}
        runActive={() => false}
        active={() => true}
        notify={(message) => notices.push(message)}
        onClose={() => {}}
        onApplied={() => {}}
      />
    )) as never,
    { width: 110, height: 24 },
  );
  await rendered.renderOnce();

  const frame = rendered.captureCharFrame();
  expect(frame).toContain("Select command review");
  expect(frame).toContain("isolation is unchanged");

  press("down");
  press("return");
  await tick();
  expect(writes).toEqual([
    {
      scope: "workspace",
      patch: {
        guard: {
          type: "shell",
          mode: "on",
          allowed_commands: ["git status"],
        },
      },
    },
  ]);
  expect(modes).toEqual(["on"]);
  expect(notices).toEqual(["review: approval (workspace)"]);
  rendered.renderer.destroy();
});
