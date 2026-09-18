import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { IsolationPicker } from "../../src/views/overlays/IsolationPicker.tsx";
import { ReviewPicker } from "../../src/views/overlays/ReviewPicker.tsx";
import { MemoryPicker } from "../../src/views/overlays/MemoryPicker.tsx";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { SettingsAdapter } from "../../src/adapters/settings.ts";
import type { GuardModeStore } from "../../src/adapters/guard-mode.ts";
import type { MemoryModeStore } from "../../src/adapters/memory-mode.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { applyIsolation } from "../../src/features/run/isolation.ts";

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

function interactionWith(keymap: ReturnType<typeof createFakeKeymap>["keymap"]): Interaction {
  return {
    keymap,
    pushOverlayContext: () => {},
    popOverlayContext: () => {},
  } as unknown as Interaction;
}

test("the isolation picker refuses a Container transition while activity is running", async () => {
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
  expect(frame).toContain("Docker");
  expect(frame).toContain("Podman");
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

test("the isolation picker selects minimal lazy Podman without Docker fallback", async () => {
  const { keymap, press } = createFakeKeymap();
  const writes: Array<{ scope: string; patch: unknown }> = [];
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
  press("down");
  press("down");
  press("return");
  await tick();
  expect(writes).toEqual([
    {
      scope: "global",
      patch: {
        runtime: { backend: "podman" },
      },
    },
  ]);
  rendered.renderer.destroy();
});

test("a Container to Sandbox transition stays modal and shows reconnect progress", async () => {
  const { keymap, press } = createFakeKeymap();
  const reload = Promise.withResolvers<{ ok: boolean; message: string }>();
  const applied: true[] = [];
  const closed: true[] = [];
  const effective = {
    runtime: { backend: "podman" as const },
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
    write: async (_scope: string, patch: unknown) => Object.assign(effective, patch as object),
  } as unknown as SettingsAdapter;
  const rendered = await openRender(
    (() => (
      <IsolationPicker
        interaction={interactionWith(keymap)}
        settings={settings}
        runActive={() => false}
        active={() => true}
        notify={() => {}}
        reload={() => reload.promise}
        onClose={() => closed.push(true)}
        onApplied={() => applied.push(true)}
      />
    )) as never,
    { width: 110, height: 24 },
  );
  await rendered.renderOnce();

  press("up");
  press("up");
  press("return");
  await tick();
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Reconnecting to Sandbox");

  press("down");
  press("escape");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Sandbox");
  expect(rendered.captureCharFrame()).toContain("Reconnecting to Sandbox");
  expect(closed).toEqual([]);

  reload.resolve({ ok: true, message: "reloaded" });
  await tick();
  expect(applied).toEqual([true]);
  rendered.renderer.destroy();
});

test.each([
  ["refused", async () => ({ ok: false, message: "activity is still draining" })],
  ["failed", async () => Promise.reject(new Error("engine unavailable"))],
] as const)(
  "a failed isolation transition restores the previous choice when reconnect is %s",
  async (_case, reload) => {
    const { keymap, press } = createFakeKeymap();
    const notices: string[] = [];
    const applied: true[] = [];
    const restored: string[] = [];
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
      write: async (_scope: string, patch: unknown) => Object.assign(effective, patch as object),
    } as unknown as SettingsAdapter;
    const rendered = await openRender(
      (() => (
        <IsolationPicker
          interaction={interactionWith(keymap)}
          settings={settings}
          runActive={() => false}
          active={() => true}
          notify={(message) => notices.push(message)}
          reload={reload}
          restore={async (isolation) => {
            restored.push(isolation);
            await applyIsolation(isolation, settings);
            return { ok: true, message: "connection restored" };
          }}
          onClose={() => {}}
          onApplied={() => applied.push(true)}
        />
      )) as never,
      { width: 80, height: 24 },
    );
    await rendered.renderOnce();
    press("down");
    press("return");
    await tick();

    expect(effective).toHaveProperty("runtime.backend", "native");
    expect(restored).toEqual(["sandbox"]);
    expect(notices).toEqual([
      _case === "refused"
        ? "isolation unchanged: activity is still draining"
        : "isolation unchanged: engine unavailable",
    ]);
    expect(applied).toEqual([]);
    await rendered.renderOnce();
    const frame = rendered.captureCharFrame();
    expect(frame).toContain("Reconnect failed");
    expect(frame).toContain(
      _case === "refused" ? "activity is still draining" : "engine unavailable",
    );
    expect(frame).toContain("Kept Sandbox");
    expect(frame).toContain("cancel");
    rendered.renderer.destroy();
  },
);

test("the review picker preserves saved approval while Container makes it inapplicable", async () => {
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
  expect(frame).toContain("Select Guard");
  expect(frame).toContain("Not applicable in Container");
  expect(frame).toContain("uncertainty is denied by default");

  press("down");
  press("return");
  await tick();
  expect(writes).toEqual([]);
  expect(modes).toEqual([]);
  expect(notices).toEqual(["Guard is not applicable in Container. Use Isolation Sandbox or Host."]);
  rendered.renderer.destroy();
});
