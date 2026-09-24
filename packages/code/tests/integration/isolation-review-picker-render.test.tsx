import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { IsolationPicker } from "../../src/views/overlays/IsolationPicker.tsx";
import { glyph } from "../../src/theme/glyphs.ts";
import { MemoryPicker } from "../../src/views/overlays/MemoryPicker.tsx";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { SettingsAdapter } from "../../src/adapters/settings.ts";
import type { MemoryModeStore } from "../../src/adapters/memory-mode.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("the memory picker changes only the session mode", async () => {
  const { keymap, press } = createFakeKeymap();
  let mode: "on" | "off" = "on";
  const notices: string[] = [];
  const applied: true[] = [];
  const memory = {
    configured: () => true,
    mode: () => mode,
    setMode: (next: "on" | "off") => {
      mode = next;
    },
  } as MemoryModeStore;
  const settings = {
    effective: () => ({ memory: { enabled: true }, default_model: "openai/model" }),
  } as unknown as SettingsAdapter;
  const rendered = await openRender(
    (() => (
      <MemoryPicker
        interaction={interactionWith(keymap)}
        settings={settings}
        memory={memory}
        active={() => true}
        notify={(message) => notices.push(message)}
        onClose={() => {}}
        onApplied={() => applied.push(true)}
      />
    )) as never,
    { width: 80, height: 24 },
  );
  await rendered.renderOnce();

  const frame = rendered.captureCharFrame();
  expect(frame).toContain("Select memory");
  expect(frame).toContain("On");
  expect(frame).toContain("Off");
  expect(frame).toContain("Persisted Memory settings are unchanged");

  press("down");
  press("return");
  expect(memory.mode()).toBe("off");
  expect(notices).toEqual(["memory: off (this session) — applies to the next run"]);
  expect(applied).toEqual([true]);
  rendered.renderer.destroy();
});

test("the isolation picker marks the host-inspected Sandbox as current", async () => {
  const { keymap } = createFakeKeymap();
  const settings = {
    effective: () => ({ sandbox: { type: "native", enabled: false } }),
    inspectSandbox: async () => ({ filesystem: { placement: "sandbox" } }),
  } as unknown as SettingsAdapter;
  const rendered = await openRender(
    (() => (
      <IsolationPicker
        interaction={interactionWith(keymap)}
        settings={settings}
        runActive={() => false}
        active={() => true}
        notify={() => {}}
        reload={async () => ({ ok: true, message: "reloaded" })}
        onClose={() => {}}
        onApplied={() => {}}
      />
    )) as never,
    { width: 100, height: 24 },
  );
  await tick();
  await rendered.renderOnce();
  const sandboxRow = rendered
    .captureCharFrame()
    .split("\n")
    .find((line) => line.includes("Sandbox") && line.includes("read host-visible"));
  expect(sandboxRow).toContain(glyph("radioOn"));
  rendered.renderer.destroy();
});

function interactionWith(keymap: ReturnType<typeof createFakeKeymap>["keymap"]): Interaction {
  return {
    keymap,
    pushOverlayContext: () => {},
    popOverlayContext: () => {},
  } as unknown as Interaction;
}

test("the isolation picker refuses a Host transition while activity is running", async () => {
  const { keymap, press } = createFakeKeymap();
  const writes: Array<{ scope: string; patch: unknown }> = [];
  const notices: string[] = [];
  const applied: true[] = [];
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
        notify={(message) => notices.push(message)}
        reload={async () => ({ ok: true, message: "reloaded" })}
        onClose={() => {}}
        onApplied={() => applied.push(true)}
      />
    )) as never,
    { width: 80, height: 24 },
  );
  await rendered.renderOnce();

  const frame = rendered.captureCharFrame();
  expect(frame).toContain("Select isolation");
  expect(frame).toContain("Host");
  expect(frame).toContain("Sandbox");
  expect(frame).toContain("use isolation");

  press("down");
  press("return");
  await tick();
  expect(writes).toEqual([]);
  expect(notices).toEqual([
    "isolation change unavailable while activity is running; stop it before reconnecting",
  ]);
  expect(applied).toEqual([]);
  rendered.renderer.destroy();
});

test("Host confirmation shows its decision keys and the warning once", async () => {
  const { keymap, press } = createFakeKeymap();
  const effective = {
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
    write: async () => {},
  } as unknown as SettingsAdapter;
  const rendered = await openRender(
    (() => (
      <IsolationPicker
        interaction={interactionWith(keymap)}
        settings={settings}
        runActive={() => false}
        active={() => true}
        notify={() => {}}
        reload={async () => ({ ok: true, message: "reloaded" })}
        onClose={() => {}}
        onApplied={() => {}}
      />
    )) as never,
    { width: 110, height: 24 },
  );
  await rendered.renderOnce();
  press("up");
  press("return");
  await rendered.renderOnce();

  const frame = rendered.captureCharFrame();
  expect(frame.match(/Run agent tools directly on this host\?/gu)).toHaveLength(1);
  expect(frame).toContain("use host");
  expect(frame).toContain("keep isolation");
  rendered.renderer.destroy();
});

test("the isolation picker saves Sandbox and reconnects before reporting success", async () => {
  const { keymap, press } = createFakeKeymap();
  const sandbox = { type: "native" as const, enabled: false };
  const settings = {
    effective: () => ({ sandbox }),
    write: async (_scope: string, patch: { sandbox: typeof sandbox }) => {
      Object.assign(sandbox, patch.sandbox);
    },
  } as unknown as SettingsAdapter;
  const events: string[] = [];
  const rendered = await openRender(
    (() => (
      <IsolationPicker
        interaction={interactionWith(keymap)}
        settings={settings}
        runActive={() => false}
        active={() => true}
        notify={(message) => events.push(message)}
        reload={async () => {
          events.push("reloaded");
          return { ok: true, message: "ready" };
        }}
        onClose={() => {}}
        onApplied={() => events.push("applied")}
      />
    )) as never,
    { width: 100, height: 24 },
  );
  await rendered.renderOnce();
  press("down");
  press("return");
  await tick();
  expect(sandbox.enabled).toBe(true);
  expect(events).toEqual(["reloaded", "isolation: sandbox (global)", "applied"]);
  rendered.renderer.destroy();
});

test("the isolation picker restores Sandbox after a failed Host reconnect", async () => {
  const { keymap, press } = createFakeKeymap();
  const sandbox = { type: "native" as const, enabled: true };
  const settings = {
    effective: () => ({ sandbox }),
    write: async (_scope: string, patch: { sandbox: typeof sandbox }) => {
      Object.assign(sandbox, patch.sandbox);
    },
  } as unknown as SettingsAdapter;
  const events: string[] = [];
  const rendered = await openRender(
    (() => (
      <IsolationPicker
        interaction={interactionWith(keymap)}
        settings={settings}
        runActive={() => false}
        active={() => true}
        notify={(message) => events.push(message)}
        reload={async () => ({ ok: false, message: "connection refused" })}
        onClose={() => {}}
        onApplied={() => events.push("applied")}
      />
    )) as never,
    { width: 100, height: 24 },
  );
  await rendered.renderOnce();
  press("up");
  press("return");
  press("y");
  await tick();
  await rendered.renderOnce();
  expect(sandbox.enabled).toBe(true);
  expect(events).toEqual(["isolation unchanged: connection refused"]);
  expect(rendered.captureCharFrame()).toContain("Kept Sandbox");
  rendered.renderer.destroy();
});
