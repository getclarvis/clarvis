import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { SettingsAdapter } from "../../src/adapters/settings.ts";
import type { GuardModeStore } from "../../src/adapters/guard-mode.ts";
import type { MemoryModeStore } from "../../src/adapters/memory-mode.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { RunControlsPanel } from "../../src/views/config/RunControlsPanel.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const fakeKeymap = createFakeKeymap;

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function mount(
  opts: {
    resolvable?: boolean;
    /** Per-scope `plans` blocks, so a test can distinguish the merged view from
     * the file the panel actually writes back to. */
    plans?: { global?: Record<string, unknown>; workspace?: Record<string, unknown> };
    /** Per-scope `guard` blocks already on disk, to prove a write merges
     * rather than clobbers them. */
    guard?: { global?: Record<string, unknown>; workspace?: Record<string, unknown> };
    /** The session guard mode `deriveRunControls` sees; defaults to "off". */
    guardMode?: "off" | "on" | "auto";
    /** The current per-client memory override; defaults to "on". */
    memoryMode?: "on" | "off";
    sandboxInspection?: { available: boolean; degraded: boolean; reason?: string } | Error;
  } = {},
) {
  const { keymap, press } = fakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const scoped = opts.plans ?? {};
  const effective = {
    memory: { enabled: true },
    default_model: "openrouter/glm-5.2",
    providers: opts.resolvable === false ? [] : [{ name: "openrouter", kind: "openai-compatible" }],
    ...(opts.sandboxInspection === undefined
      ? {}
      : { sandbox: { type: "bubblewrap", enabled: true, availability: "optional" } }),
    ...((scoped.workspace ?? scoped.global) ? { plans: scoped.workspace ?? scoped.global } : {}),
    ...((opts.guard?.workspace ?? opts.guard?.global)
      ? { guard: opts.guard?.workspace ?? opts.guard?.global }
      : {}),
  };
  const writes: { scope: string; patch: unknown }[] = [];
  const settings = {
    version: () => 0,
    effective: () => effective,
    read: (scope: "global" | "workspace") =>
      scoped[scope] || opts.guard?.[scope]
        ? { plans: scoped[scope], guard: opts.guard?.[scope] }
        : undefined,
    origin: (key: string) => {
      if (key === "guard")
        return opts.guard?.workspace ? "workspace" : opts.guard?.global ? "global" : undefined;
      if (key === "plans")
        return scoped.workspace ? "workspace" : scoped.global ? "global" : undefined;
      return undefined;
    },
    write: async (scope: string, patch: unknown) => {
      writes.push({ scope, patch });
    },
    validateProviders: () => ({ ok: opts.resolvable !== false }),
    inspectSandbox: async () => {
      if (opts.sandboxInspection instanceof Error) throw opts.sandboxInspection;
      return {
        bubblewrap: opts.sandboxInspection ?? { available: true, degraded: false },
      };
    },
  } as unknown as SettingsAdapter;
  const guardSetModeCalls: string[] = [];
  const guard = {
    mode: () => opts.guardMode ?? "off",
    setMode: (m: string) => guardSetModeCalls.push(m),
  } as unknown as GuardModeStore;
  const [memoryMode, setMemoryMode] = createSignal<"on" | "off">(opts.memoryMode ?? "on");
  const memorySetModeCalls: string[] = [];
  const memory = {
    mode: memoryMode,
    setMode: (mode: "on" | "off") => {
      memorySetModeCalls.push(mode);
      setMemoryMode(mode);
    },
    refresh: () => {},
    configured: () => true,
    cycle: () => "on",
  } as unknown as MemoryModeStore;
  const notes: string[] = [];
  const sandboxOpened: true[] = [];
  const deps = {
    settings,
    guard,
    memory,
    notify: (m: string) => {
      notes.push(m);
    },
    runActive: () => false,
    openSandbox: () => sandboxOpened.push(true),
  };
  return {
    host,
    deps,
    press,
    notes,
    writes,
    guardSetModeCalls,
    memorySetModeCalls,
    sandboxOpened,
  };
}

async function selectOption(
  press: (key: string) => void,
  render: () => Promise<void>,
  row: number,
  moves: readonly string[],
): Promise<void> {
  for (let i = 0; i < row; i++) press("down");
  press("return");
  await render();
  for (const move of moves) press(move);
  press("return");
  await tick();
}

async function activateGuard(
  press: (key: string) => void,
  render: () => Promise<void>,
  index: 0 | 1 | 2,
): Promise<void> {
  await selectOption(
    press,
    render,
    1,
    Array.from({ length: index }, () => "down"),
  );
}

async function activateMemoryOn(
  press: (key: string) => void,
  render: () => Promise<void>,
): Promise<void> {
  await selectOption(press, render, 2, ["up"]);
}

async function activateMemoryOff(
  press: (key: string) => void,
  render: () => Promise<void>,
): Promise<void> {
  await selectOption(press, render, 2, ["down"]);
}

test("the safety row opens sandbox details and persists a selected protected preset", async () => {
  const { host, deps, press, notes, writes, guardSetModeCalls, sandboxOpened } = mount();
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();

  press("b");
  expect(sandboxOpened).toEqual([true]);
  await selectOption(press, () => t.renderOnce(), 0, ["down", "down", "down", "down", "down"]);

  expect(writes).toEqual([
    {
      scope: "global",
      patch: {
        guard: { type: "shell", mode: "on" },
        sandbox: {
          type: "bubblewrap",
          enabled: true,
          availability: "required",
          filesystem: "workspace-write",
          network: "host",
          toolchains: { mode: "auto" },
        },
      },
    },
  ]);
  expect(guardSetModeCalls).toEqual(["on"]);
  expect(notes).toEqual(["safety: protected (global)"]);
  t.renderer.destroy();
});

test("judged confirms direct host execution and persists guard auto without a sandbox", async () => {
  const { host, deps, press, notes, writes, guardSetModeCalls } = mount();
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();

  press("return");
  await t.renderOnce();
  press("down");
  press("return");
  await tick();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Judged mode runs commands directly on the host");
  expect(writes).toEqual([]);

  press("y");
  await tick();
  expect(writes).toEqual([
    {
      scope: "global",
      patch: {
        guard: { type: "shell", mode: "auto" },
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
  expect(guardSetModeCalls).toEqual(["auto"]);
  expect(notes).toEqual(["safety: judged (global)"]);
  t.renderer.destroy();
});

test("a reviewed safety preset preserves the scope's allow and deny policy", async () => {
  const { host, deps, press, writes } = mount({
    guard: {
      global: {
        type: "shell",
        allowed_commands: ["bun run test:coverage"],
        denied_commands: ["git push --force*"],
      },
    },
  });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  await selectOption(press, () => t.renderOnce(), 0, ["down", "down", "down", "down"]);
  expect(writes[0]).toMatchObject({
    scope: "global",
    patch: {
      guard: {
        type: "shell",
        mode: "auto",
        allowed_commands: ["bun run test:coverage"],
        denied_commands: ["git push --force*"],
      },
    },
  });
  t.renderer.destroy();
});

test("a workspace safety preset carries forward the global command policy", async () => {
  const { host, deps, press, writes } = mount({
    guard: {
      global: { type: "shell", allowed_commands: ["bun test"], denied_commands: ["rm -rf *"] },
    },
  });
  host.toggleScope();
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  await selectOption(press, () => t.renderOnce(), 0, ["down", "down", "down", "down"]);
  expect(writes[0]).toMatchObject({
    scope: "workspace",
    patch: {
      guard: {
        type: "shell",
        mode: "auto",
        allowed_commands: ["bun test"],
        denied_commands: ["rm -rf *"],
      },
    },
  });
  t.renderer.destroy();
});

test("the safety status distinguishes checking, unavailable, degraded and optional hosts", async () => {
  const cases = [
    {
      inspection: new Error("probe failed"),
      expected: "Checking Bubblewrap on the kernel host",
    },
    {
      inspection: { available: false, degraded: false, reason: "missing" },
      expected: "optional sandbox runs directly on the host",
    },
    {
      inspection: { available: true, degraded: true },
      expected: "Bubblewrap runs in degraded mode",
    },
  ] as const;
  for (const item of cases) {
    const mounted = mount({ sandboxInspection: item.inspection });
    const rendered = await openRender(
      (() => RunControlsPanel(mounted.host, mounted.deps)) as never,
      { width: 110, height: 40 },
    );
    await tick();
    await rendered.renderOnce();
    expect(rendered.captureCharFrame()).toContain(item.expected);
    rendered.renderer.destroy();
  }
});

test("turning memory off changes only the session store", async () => {
  const { host, deps, press, notes, writes, memorySetModeCalls } = mount();
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  await activateMemoryOff(press, () => t.renderOnce());
  expect(writes).toEqual([]);
  expect(memorySetModeCalls).toEqual(["off"]);
  expect(notes).toEqual(["memory: off (this session) — applies to the next run"]);
  t.renderer.destroy();
});

test("the guard-mode row writes settings.guard.mode at scope and syncs the session store", async () => {
  const { host, deps, press, notes, writes, guardSetModeCalls } = mount();
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  await activateGuard(press, () => t.renderOnce(), 1);
  expect(writes).toEqual([{ scope: "global", patch: { guard: { type: "shell", mode: "on" } } }]);
  expect(notes).toEqual(["guard: on (global settings)"]);
  expect(guardSetModeCalls).toEqual(["on"]);
  t.renderer.destroy();
});

test("the guard-mode row merges onto an existing guard block instead of clobbering it", async () => {
  const { host, deps, press, writes } = mount({
    guard: { global: { type: "shell", allowed_commands: ["git status"] } },
  });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  await activateGuard(press, () => t.renderOnce(), 2);
  expect(writes).toEqual([
    {
      scope: "global",
      patch: { guard: { type: "shell", allowed_commands: ["git status"], mode: "auto" } },
    },
  ]);
  t.renderer.destroy();
});

test("guard 'auto' without a resolvable model falls back to writing 'on', not a misleading 'auto'", async () => {
  const { host, deps, press, notes, writes, guardSetModeCalls } = mount({ resolvable: false });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  await activateGuard(press, () => t.renderOnce(), 2);
  expect(writes).toEqual([{ scope: "global", patch: { guard: { type: "shell", mode: "on" } } }]);
  expect(guardSetModeCalls).toEqual(["on"]);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("guard: on (global settings)");
  expect(notes[0]).toContain("using on until one is configured");
  t.renderer.destroy();
});

test("a guard mode that matches no safety preset shows the custom caption", async () => {
  const { host, deps } = mount({
    guardMode: "auto",
    sandboxInspection: { available: true, degraded: false },
  });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  const out = t.captureCharFrame();
  expect(out).toContain("Safety preset  custom");
  t.renderer.destroy();
});

test("command review separates an inherited scoped value from a session override", async () => {
  const inherited = mount({
    guard: { global: { type: "shell", mode: "auto" } },
    guardMode: "auto",
  });
  await inherited.host.toggleScope();
  const first = await openRender(
    (() => RunControlsPanel(inherited.host, inherited.deps)) as never,
    {
      width: 110,
      height: 40,
    },
  );
  await first.renderOnce();
  inherited.press("down");
  await first.renderOnce();
  const inheritedFrame = first.captureCharFrame();
  expect(inheritedFrame).toContain("Configured here: inherit");
  expect(inheritedFrame).toContain("Effective:       auto");
  expect(inheritedFrame).toContain("Source:          global");
  first.renderer.destroy();

  const overridden = mount({
    guard: { global: { type: "shell", mode: "auto" } },
    guardMode: "off",
  });
  await overridden.host.toggleScope();
  const second = await openRender(
    (() => RunControlsPanel(overridden.host, overridden.deps)) as never,
    { width: 110, height: 40 },
  );
  await second.renderOnce();
  overridden.press("down");
  await second.renderOnce();
  const overriddenFrame = second.captureCharFrame();
  expect(overriddenFrame).toContain("Configured here: inherit");
  expect(overriddenFrame).toContain("Effective:       off");
  expect(overriddenFrame).toContain("Source:          session");
  second.renderer.destroy();
});

test("changing the planning mode preserves the scope's retention and nudge budget", async () => {
  const { host, deps, press, notes, writes } = mount({
    plans: { global: { mode: "on", retention: "discard", pending_task_nudges: 7 } },
  });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  await selectOption(press, () => t.renderOnce(), 3, ["down"]);
  expect(writes).toEqual([
    {
      scope: "global",
      patch: { plans: { mode: "review", retention: "discard", pending_task_nudges: 7 } },
    },
  ]);
  expect(notes[0]).toContain("planning: require approval (global settings)");
  t.renderer.destroy();
});

test("changing planning policy preserves plans.provider", async () => {
  const { host, deps, press, writes } = mount({
    plans: {
      global: {
        mode: "on",
        retention: "keep",
        pending_task_nudges: 3,
        provider: { kind: "plugin", plugin: "linear" },
      },
    },
  });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  await selectOption(press, () => t.renderOnce(), 3, ["down"]);
  expect(writes).toEqual([
    {
      scope: "global",
      patch: {
        plans: {
          mode: "review",
          retention: "keep",
          pending_task_nudges: 3,
          provider: { kind: "plugin", plugin: "linear" },
        },
      },
    },
  ]);
  t.renderer.destroy();
});

test("retention descriptions are provider-neutral", async () => {
  const { host, deps } = mount();
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Plan history  keep plans");
  expect(frame).not.toContain(".clarvis/plans");
  expect(frame).not.toContain("Plan files");
  t.renderer.destroy();
});

test("changing the plan history preserves the mode", async () => {
  const { host, deps, press, writes, notes } = mount({
    plans: { global: { mode: "review", retention: "keep", pending_task_nudges: 3 } },
  });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  await selectOption(press, () => t.renderOnce(), 4, ["down"]);
  expect(writes).toEqual([
    {
      scope: "global",
      patch: { plans: { mode: "review", retention: "discard", pending_task_nudges: 3 } },
    },
  ]);
  expect(notes[0]).toContain("plan history: delete after a successful run");
  t.renderer.destroy();
});

test("'No planning' persists mode 'off' rather than deleting the block", async () => {
  const { host, deps, press, writes } = mount({
    plans: { global: { mode: "on", retention: "keep", pending_task_nudges: 3 } },
  });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  await selectOption(press, () => t.renderOnce(), 3, ["up"]);
  expect(writes).toEqual([
    {
      scope: "global",
      patch: { plans: { mode: "off", retention: "keep", pending_task_nudges: 3 } },
    },
  ]);
  t.renderer.destroy();
});

test("a workspace write does not inherit the global retention into the workspace block", async () => {
  const { host, deps, press, writes } = mount({
    plans: { global: { mode: "on", retention: "discard", pending_task_nudges: 9 } },
  });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  await host.toggleScope();
  await selectOption(press, () => t.renderOnce(), 3, ["down"]);
  expect(writes).toEqual([
    {
      scope: "workspace",
      patch: { plans: { mode: "review", retention: "discard", pending_task_nudges: 9 } },
    },
  ]);
  t.renderer.destroy();
});

test("an unconfigured workspace reports the defaults without claiming a scope", async () => {
  const { host, deps } = mount();
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  const out = t.captureCharFrame();
  expect(out).toContain("product default");
  expect(out).toContain("Plan history  keep plans");
  expect(out).toContain("Planning mode  on");
  t.renderer.destroy();
});

test("enabling session memory warns when the configured model is inert", async () => {
  const { host, deps, press, notes, writes, memorySetModeCalls } = mount({
    resolvable: false,
    memoryMode: "off",
  });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  await activateMemoryOn(press, () => t.renderOnce());
  expect(writes).toEqual([]);
  expect(memorySetModeCalls).toEqual(["on"]);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("memory: on (this session)");
  expect(notes[0]).toContain("memory will not learn");
  expect(notes[0]).toContain("Memory settings");
  t.renderer.destroy();
});
