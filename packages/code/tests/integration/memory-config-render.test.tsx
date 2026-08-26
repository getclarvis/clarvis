import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { SettingsAdapter, SettingsFile } from "../../src/adapters/settings.ts";
import type { MemoryModeStore } from "../../src/adapters/memory-mode.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { MemoryConfigPanel } from "../../src/views/config/MemoryConfigPanel.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const fakeKeymap = createFakeKeymap;

const PROVIDERS = [{ name: "openrouter", kind: "openai-compatible", models: {} }];

type MemoryDraftLike = NonNullable<SettingsFile["memory"]>;

function mount(
  opts: {
    resolvable?: boolean;
    cycleTo?: "on" | "off";
    draftMemory?: MemoryDraftLike | null;
    effectiveMemory?: MemoryDraftLike | null;
    memoryOrigin?: "global" | "workspace";
    configured?: boolean;
    sessionMode?: "on" | "off";
    initialScope?: "global" | "workspace";
  } = {},
) {
  const { keymap, press } = fakeKeymap();
  const { host, controls } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
    initialScope: opts.initialScope,
  });
  const draftMemory = opts.draftMemory === undefined ? { enabled: true } : opts.draftMemory;
  const effectiveMemory =
    opts.effectiveMemory === undefined ? { enabled: true } : opts.effectiveMemory;
  const effective = {
    memory: effectiveMemory ?? undefined,
    providers: opts.resolvable === false ? [] : PROVIDERS,
    default_model: "openrouter/glm-5.2",
  };
  const writes: { scope: string; patch: { memory?: unknown } }[] = [];
  const settings = {
    read: () => ({ memory: draftMemory ?? undefined, providers: PROVIDERS }),
    effective: () => effective,
    origin: (key: string) => (key === "memory" ? opts.memoryOrigin : undefined),
    write: async (scope: string, patch: { memory?: unknown }) => {
      writes.push({ scope, patch });
    },
  } as unknown as SettingsAdapter;
  const modeCalls: string[] = [];
  const memoryMode = {
    configured: () => opts.configured ?? true,
    mode: () => opts.sessionMode ?? "on",
    setMode: (m: string) => modeCalls.push(m),
    cycle: () => opts.cycleTo ?? "off",
    refresh: () => {},
  } as unknown as MemoryModeStore;
  const notes: string[] = [];
  const deps = { settings, memoryMode, notify: (m: string) => notes.push(m) };
  return { host, controls, deps, notes, press, writes, modeCalls };
}

test("the effective status line and its note share the FieldRow value column", async () => {
  const { host, deps } = mount();
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  const rows = t.captureCharFrame().split("\n");
  const colOf = (needle: string): number => rows.find((r) => r.includes(needle))!.indexOf(needle);
  expect(colOf("On — runs can read and update workspace memory")).toBe(
    colOf("active for every run when configured"),
  );
  t.renderer.destroy();
});

test("the session toggle labels its scope: 'memory: on (session)'", async () => {
  const { host, deps, notes, press } = mount({ cycleTo: "on" });
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  press("down");
  press("down");
  press("return");
  expect(notes).toEqual(["memory: on (session)"]);
  t.renderer.destroy();
});

test("activating the session toggle while inert warns that memory will not learn", async () => {
  const { host, deps, notes, press } = mount({ cycleTo: "on", resolvable: false });
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  press("down");
  press("down");
  press("return");
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("memory: on (session)");
  expect(notes[0]).toContain("memory will not learn");
  t.renderer.destroy();
});

test("no memory block: the fallback row renders and creating one warns when default_model does not resolve", async () => {
  const { host, deps, notes, press } = mount({
    draftMemory: null,
    effectiveMemory: null,
    resolvable: false,
  });
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  let frame = t.captureCharFrame();
  expect(frame).toContain("Memory  off · from product default · next run");
  expect(frame).toContain("[↵] create");
  expect(host.dirty()).toBe(false);
  press("return");
  await t.renderOnce();
  expect(host.dirty()).toBe(true);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("no usable default_model");
  frame = t.captureCharFrame();
  expect(frame).toContain("Memory  current off → after save on · next run");
  expect(frame).toContain("Pending:         on");
  expect(frame).not.toContain("browse memory");
  t.renderer.destroy();
});

test("no memory block: creating one when default_model resolves does not warn", async () => {
  const { host, deps, notes, press } = mount({ draftMemory: null, resolvable: true });
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  expect(notes).toEqual([]);
  t.renderer.destroy();
});

test("creating a scoped block copies the effective provider, model and budgets", async () => {
  const effectiveMemory: MemoryDraftLike = {
    enabled: false,
    model: "openrouter/glm-5.2",
    budgets: { seed_chars: 900, digest_tokens: 800, max_index_ops: 4 },
    provider: { kind: "file", paths: ["AGENTS.md"] },
  };
  const { host, controls, deps, press, writes } = mount({
    draftMemory: null,
    effectiveMemory,
    initialScope: "workspace",
  });
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  press("return");
  await controls.runSave();
  expect(writes).toEqual([
    {
      scope: "workspace",
      patch: { memory: { ...effectiveMemory, enabled: true } },
    },
  ]);
  t.renderer.destroy();
});

test("removing the block via 'x' clears the draft, dirties the host, and notifies", async () => {
  const { host, deps, notes, press } = mount();
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  press("x");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Configured here: on");
  expect(frame).toContain("Pending:         inherit");
  expect(host.dirty()).toBe(true);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("memory block removed from the global draft");
  t.renderer.destroy();
});

test("toggling 'enabled' on row 0 flips the draft and dirties the host", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain(" on");
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("off");
  expect(host.dirty()).toBe(true);
  t.renderer.destroy();
});

test("activating the session row while memory is not configured warns instead of cycling", async () => {
  const { host, deps, notes, press } = mount({
    draftMemory: null,
    effectiveMemory: null,
    configured: false,
  });
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  press("down");
  press("return");
  expect(notes).toEqual(["memory is not configured in settings— save a block first"]);
  t.renderer.destroy();
});

test("the session toggle labels its scope when it cycles to off: 'memory: off (session)'", async () => {
  const { host, deps, notes, press } = mount({ cycleTo: "off" });
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  press("down");
  press("down");
  press("return");
  expect(notes).toEqual(["memory: off (session)"]);
  t.renderer.destroy();
});

test("status line: no memory block anywhere reads as off", async () => {
  const { host, deps } = mount({ effectiveMemory: null });
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Off — no memory configuration is effective");
  t.renderer.destroy();
});

test("status line: explicitly disabled reads as off", async () => {
  const { host, deps } = mount({ effectiveMemory: { enabled: false } });
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Off — disabled by settings");
  t.renderer.destroy();
});

test("status line: enabled but unresolved model reads as inert", async () => {
  const { host, deps } = mount({ resolvable: false });
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Unavailable — no extraction model resolves");
  t.renderer.destroy();
});

test("status line: resolved but the session override is off stays semantic", async () => {
  const { host, deps } = mount({ sessionMode: "off" });
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain(
    "Off for this session — configured default remains unchanged",
  );
  t.renderer.destroy();
});

test("editing the model field with no configured providers falls back to the manual text editor", async () => {
  const { host, deps, press } = mount({ resolvable: false });
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  press("down");
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("model (provider/modelId)");
  t.renderer.destroy();
});

test("editing the model field with configured providers opens the catalog picker", async () => {
  const { host, deps, press } = mount({ resolvable: true });
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  press("down");
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Pick a model — configured providers");
  t.renderer.destroy();
});

test("save(): enabled and resolvable turns session memory on and reports it", async () => {
  const { host, controls, deps, notes, writes, modeCalls } = mount({ resolvable: true });
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  host.markDirty(true);
  await controls.runSave();
  expect(writes).toEqual([{ scope: "global", patch: { memory: { enabled: true } } }]);
  expect(host.dirty()).toBe(false);
  expect(modeCalls).toEqual(["on"]);
  expect(notes).toEqual(["saved global memory config — session memory on"]);
  t.renderer.destroy();
});

test("save(): enabled but inert warns that memory will not learn", async () => {
  const { host, controls, deps, notes, modeCalls } = mount({ resolvable: false });
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  await controls.runSave();
  expect(modeCalls).toEqual(["on"]);
  expect(notes).toEqual([
    "saved global memory config — memory model not resolved; memory will not learn",
  ]);
  t.renderer.destroy();
});

test("save(): no draft saves generically without touching session mode", async () => {
  const { host, controls, deps, notes, writes, modeCalls } = mount({ draftMemory: null });
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  await controls.runSave();
  expect(writes).toEqual([{ scope: "global", patch: { memory: undefined } }]);
  expect(modeCalls).toEqual([]);
  expect(notes).toEqual(["saved global memory config"]);
  t.renderer.destroy();
});

test("editable rows use product labels and an explicit mutation affordance", async () => {
  const { host, deps } = mount();
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Memory  on");
  expect(frame).toContain("change Memory");
  expect(frame).toContain("Extraction model");
  expect(frame).not.toContain("true");
  t.renderer.destroy();
});

test("Source names the scope whose value actually won, not the scope on screen", async () => {
  // Viewing global while a workspace override is in force: the badge used to
  // say `global` because the viewed scope declared a block at all, while a run
  // used the workspace's value.
  const { host, deps } = mount({ draftMemory: { enabled: true }, memoryOrigin: "workspace" });
  const t = await openRender((() => MemoryConfigPanel(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("from workspace");
  t.renderer.destroy();
});
