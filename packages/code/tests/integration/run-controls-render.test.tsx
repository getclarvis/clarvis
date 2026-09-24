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
    memoryEnabled?: boolean;
    /** Optional container runtime used to exercise its effective descriptions. */
    runtime?: { backend: "docker" };
    sandboxInspection?:
      | {
          available: boolean;
          degraded: boolean;
          reason?: string;
          placement?: "host" | "sandbox";
          network?: "host" | "none";
        }
      | Error;
    effectiveSandboxEnabled?: boolean;
    runActive?: boolean;
    reloadResult?: { ok: boolean; message: string };
    writeError?: Error;
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
    memory: { enabled: opts.memoryEnabled ?? true },
    default_model: "openrouter/glm-5.2",
    providers: opts.resolvable === false ? [] : [{ name: "openrouter", kind: "openai-compatible" }],
    ...(opts.runtime === undefined ? {} : { runtime: opts.runtime }),
    ...(opts.sandboxInspection === undefined
      ? {}
      : {
          sandbox: {
            type: "native",
            enabled: opts.effectiveSandboxEnabled ?? true,
            availability: "optional",
          },
        }),
    ...((scoped.workspace ?? scoped.global) ? { plans: scoped.workspace ?? scoped.global } : {}),
    ...((opts.guard?.workspace ?? opts.guard?.global)
      ? { guard: opts.guard?.workspace ?? opts.guard?.global }
      : {}),
  };
  const writes: { scope: string; patch: unknown }[] = [];
  let inspectionCalls = 0;
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
      if (opts.writeError) throw opts.writeError;
      writes.push({ scope, patch });
      Object.assign(effective, patch);
    },
    validateProviders: () => ({ ok: opts.resolvable !== false }),
    inspectSandbox: async () => {
      inspectionCalls++;
      if (opts.sandboxInspection instanceof Error) throw opts.sandboxInspection;
      const placement =
        opts.sandboxInspection?.placement ??
        (opts.sandboxInspection === undefined ? "host" : "sandbox");
      return {
        effective_network: opts.sandboxInspection?.network ?? "host",
        filesystem: {
          placement,
          reads: "host-visible",
          writes: placement === "sandbox" ? "declared-roots" : "host-os",
          workspace: "read-write",
        },
        backend: {
          type: "bubblewrap",
          mode: "fresh-proc",
          ...(opts.sandboxInspection ?? { available: true, degraded: false }),
        },
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
    runActive: () => opts.runActive ?? false,
    reload: async () => opts.reloadResult ?? { ok: true, message: "reloaded" },
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
    inspectionCalls: () => inspectionCalls,
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

test("the isolation row opens sandbox details and persists minimal lazy Docker", async () => {
  const { host, deps, press, notes, writes, guardSetModeCalls, sandboxOpened, inspectionCalls } =
    mount();
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();

  press("b");
  expect(sandboxOpened).toEqual([true]);
  await selectOption(press, () => t.renderOnce(), 0, ["down", "down"]);

  expect(writes).toEqual([
    {
      scope: "global",
      patch: {
        runtime: { backend: "docker" },
      },
    },
  ]);
  expect(guardSetModeCalls).toEqual([]);
  expect(notes).toEqual(["isolation: docker (global)"]);
  expect(inspectionCalls()).toBe(2);
  t.renderer.destroy();
});

test("an isolation change during a run is saved for the next run without reconnecting", async () => {
  const { host, deps, press, notes, writes } = mount({ runActive: true });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  await selectOption(press, () => t.renderOnce(), 0, ["down", "down"]);
  expect(writes).toHaveLength(1);
  expect(notes).toEqual(["isolation: docker (global) — applies to the next run"]);
  t.renderer.destroy();
});

test("an isolation reconnect refusal reports that the saved setting is pending", async () => {
  const { host, deps, press, notes, writes } = mount({
    reloadResult: { ok: false, message: "run still owns the host" },
  });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  await selectOption(press, () => t.renderOnce(), 0, ["down", "down"]);
  expect(writes).toHaveLength(1);
  expect(notes).toEqual(["isolation saved, pending reconnect: run still owns the host"]);
  t.renderer.destroy();
});

test("an isolation write failure is surfaced without claiming a change", async () => {
  const { host, deps, press, notes, writes } = mount({
    writeError: new Error("disk is read-only"),
  });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  await selectOption(press, () => t.renderOnce(), 0, ["down", "down"]);
  expect(writes).toEqual([]);
  expect(notes).toEqual(["disk is read-only"]);
  t.renderer.destroy();
});

test("the native sandbox detail reports a healthy available backend", async () => {
  const { host, deps, press } = mount({
    sandboxInspection: { available: true, degraded: false },
  });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await tick();
  await t.renderOnce();
  press("i");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain(
    "Bubblewrap is available; an incompatible host fails closed.",
  );
  t.renderer.destroy();
});

test("run controls follow host Sandbox inspection over a weaker workspace merge", async () => {
  const { host, deps, press } = mount({
    effectiveSandboxEnabled: false,
    sandboxInspection: { available: true, degraded: false, placement: "sandbox" },
  });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await tick();
  await t.renderOnce();
  press("i");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain(
    "Bubblewrap is available; an incompatible host fails closed.",
  );
  t.renderer.destroy();
});

test("the Docker consequences remain complete in a narrow Run controls viewport", async () => {
  const { host, deps, press } = mount({ runtime: { backend: "docker" } });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 72,
    height: 40,
  });
  await t.renderOnce();
  press("i");
  await t.renderOnce();

  const frame = t.captureCharFrame();
  const prose = frame.replaceAll(/\s+/gu, " ");
  expect(prose).toContain(
    "The selected workspace is mounted directly; changes appear on the host immediately.",
  );
  expect(prose).toContain(
    "Skills, MCPs, Hooks, Plugins, Tasks and external capability providers are unavailable.",
  );
  expect(prose).toContain("Outbound network access is enabled and may cause remote effects");
  expect(prose).toContain("Commands run without Guard.");
  expect(prose).toContain("Git metadata is read-only; use Sandbox or Host for commits.");
  expect(prose).toContain(
    "Docker stays cold until the first run and fails closed if it cannot start.",
  );
  expect(frame.split("\n").every((line) => line.length <= 72)).toBe(true);
  t.renderer.destroy();
});

test("Host isolation requires confirmation and leaves command review untouched", async () => {
  const { host, deps, press, notes, writes, guardSetModeCalls } = mount({
    sandboxInspection: { available: true, degraded: false },
  });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();

  press("return");
  await t.renderOnce();
  press("up");
  press("return");
  await tick();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Run agent tools directly on this host?");
  expect(writes).toEqual([]);

  press("y");
  await tick();
  expect(writes).toEqual([
    {
      scope: "global",
      patch: {
        runtime: { backend: "native" },
        sandbox: {
          type: "native",
          enabled: false,
          availability: "required",
          filesystem: "workspace-write",
          network: "host",
          toolchains: { mode: "auto" },
        },
      },
    },
  ]);
  expect(guardSetModeCalls).toEqual([]);
  expect(notes).toEqual(["isolation: host (global)"]);
  t.renderer.destroy();
});

test("Auto review preserves the scope's allow and deny policy", async () => {
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
  await activateGuard(press, () => t.renderOnce(), 2);
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

test("workspace Auto review carries forward the global command policy", async () => {
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
  await activateGuard(press, () => t.renderOnce(), 2);
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

test("the isolation status distinguishes checking, unavailable, and degraded hosts", async () => {
  const cases = [
    {
      inspection: new Error("probe failed"),
      expected: "Checking native sandbox on the kernel host",
    },
    {
      inspection: { available: false, degraded: false, reason: "missing" },
      expected: "sandbox fails every run",
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
    mounted.press("i");
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

test("the memory detail explains the effective session behavior", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  press("down");
  press("down");
  press("i");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Run controls ▸ Memory for this session");
  expect(frame).toContain("Reads memory before the run and learns from it afterward.");
  t.renderer.destroy();
});

test("enabling session memory reports when global memory is disabled", async () => {
  const { host, deps, press, notes, memorySetModeCalls } = mount({
    memoryEnabled: false,
    memoryMode: "off",
  });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  await activateMemoryOn(press, () => t.renderOnce());
  expect(memorySetModeCalls).toEqual(["on"]);
  expect(notes).toEqual([
    "memory remains off — enable it in Settings > Memory before the next run",
  ]);
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
  expect(notes).toEqual(["Guard: approval (global settings)"]);
  expect(guardSetModeCalls).toEqual(["on"]);
  t.renderer.destroy();
});

test("a guard write failure is surfaced without changing the session mode", async () => {
  const { host, deps, press, notes, guardSetModeCalls } = mount({
    writeError: new Error("guard settings unavailable"),
  });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  await activateGuard(press, () => t.renderOnce(), 1);
  expect(guardSetModeCalls).toEqual([]);
  expect(notes).toEqual(["guard settings unavailable"]);
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
  expect(notes[0]).toContain("Guard: approval (global settings)");
  expect(notes[0]).toContain("Auto needs a usable default_model");
  t.renderer.destroy();
});

test("isolation and review remain separately visible for a noncanonical legacy pair", async () => {
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
  expect(out).toContain("Isolation  sandbox");
  expect(out).toContain("Guard  auto");
  expect(out).not.toContain("custom");
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
  inherited.press("i");
  await first.renderOnce();
  const inheritedFrame = first.captureCharFrame();
  expect(inheritedFrame).toContain("Configured: inherit");
  expect(inheritedFrame).toContain("Effective: auto");
  expect(inheritedFrame).toContain("Source: global");
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
  overridden.press("i");
  await second.renderOnce();
  const overriddenFrame = second.captureCharFrame();
  expect(overriddenFrame).toContain("Configured: inherit");
  expect(overriddenFrame).toContain("Effective: off");
  expect(overriddenFrame).toContain("Source: session");
  second.renderer.destroy();
});

test("Run controls exposes retention without a planning-mode control", async () => {
  const { host, deps } = mount({
    plans: { global: { mode: "review", retention: "keep", pending_task_nudges: 3 } },
  });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Completed plans  keep plans");
  expect(frame).not.toContain("Planning mode");
  expect(frame).not.toContain("Require approval");
  expect(frame).not.toContain("No planning");
  t.renderer.destroy();
});

test("an explicit discard policy is named consistently in overview and detail", async () => {
  const { host, deps, press } = mount({
    plans: { global: { retention: "discard" } },
  });
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 110,
    height: 40,
  });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Completed plans  delete after success");
  press("down");
  press("down");
  press("down");
  press("i");
  await t.renderOnce();
  const detail = t.captureCharFrame();
  expect(detail).toContain("Effective: delete after success");
  expect(detail).toContain("Successful runs delete their plan after the result is recorded.");
  t.renderer.destroy();
});

test("changing completed-plan retention preserves mode, nudge budget and provider", async () => {
  const { host, deps, press, writes } = mount({
    plans: {
      global: {
        mode: "review",
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
          retention: "discard",
          pending_task_nudges: 3,
          provider: { kind: "plugin", plugin: "linear" },
        },
      },
    },
  ]);
  t.renderer.destroy();
});

test("retention surfaces are provider-neutral and contain no history-browser vocabulary", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => RunControlsPanel(host, deps)) as never, {
    width: 140,
    height: 40,
  });
  await t.renderOnce();
  let frame = t.captureCharFrame();
  expect(frame).toContain("Completed plans  keep plans");
  expect(frame).not.toContain(".clarvis/plans");
  expect(frame).not.toContain("Plan files");

  press("down");
  press("down");
  press("down");
  press("return");
  await t.renderOnce();
  frame = t.captureCharFrame();
  expect(frame).toContain("plans remain available in the selected provider");
  expect(frame.toLowerCase()).not.toContain("history");
  t.renderer.destroy();
});

test("changing completed-plan retention preserves the mode", async () => {
  const { host, deps, press, writes, notes } = mount({
    plans: { global: { mode: "review", retention: "keep", pending_task_nudges: 3 } },
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
      patch: { plans: { mode: "review", retention: "discard", pending_task_nudges: 3 } },
    },
  ]);
  expect(notes[0]).toContain("completed plans: delete after a successful run");
  t.renderer.destroy();
});

test("a workspace retention write carries the effective plan policy into its block", async () => {
  const { host, deps, press, writes } = mount({
    plans: { global: { mode: "review", retention: "keep", pending_task_nudges: 9 } },
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
  expect(out).toContain("Completed plans  keep plans");
  expect(out).not.toContain("Planning mode");
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
