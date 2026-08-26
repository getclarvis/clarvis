import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import type { SandboxInspection } from "@clarvis/protocol";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { SettingsAdapter, SettingsFile } from "../../src/adapters/settings.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { SandboxConfigPanel } from "../../src/views/config/SandboxConfigPanel.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const fakeKeymap = createFakeKeymap;

const INSPECTION: SandboxInspection = {
  bubblewrap: { available: true, mode: "fresh-proc", degraded: false },
  toolchains: [],
  extra_paths: [],
  effective_path: [],
};

const SANDBOX: NonNullable<SettingsFile["sandbox"]> = { type: "bubblewrap", enabled: true };

const UNAVAILABLE_INSPECTION: SandboxInspection = {
  bubblewrap: { available: false, mode: "unavailable", degraded: false, reason: "not installed" },
  toolchains: [],
  extra_paths: [],
  effective_path: [],
};

const DEGRADED_INSPECTION: SandboxInspection = {
  bubblewrap: { available: true, mode: "fresh-proc", degraded: true },
  toolchains: [],
  extra_paths: [],
  effective_path: [],
};

function mount(
  opts: {
    inspect?: (refresh?: boolean) => Promise<SandboxInspection>;
    readSandbox?: NonNullable<SettingsFile["sandbox"]> | null;
    effectiveSandbox?: NonNullable<SettingsFile["sandbox"]> | null;
    initialScope?: "global" | "workspace";
    scopes?: {
      global?: NonNullable<SettingsFile["sandbox"]>;
      workspace?: NonNullable<SettingsFile["sandbox"]>;
    };
  } = {},
) {
  const { keymap, press } = fakeKeymap();
  const inspections: boolean[] = [];
  const { host, controls } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
    initialScope: opts.initialScope,
  });
  const readSandbox = opts.readSandbox === undefined ? SANDBOX : (opts.readSandbox ?? undefined);
  const selectedScope = opts.initialScope ?? "global";
  const scopes = opts.scopes ?? (readSandbox ? { [selectedScope]: readSandbox } : {});
  const effectiveSandbox =
    opts.effectiveSandbox === undefined ? SANDBOX : (opts.effectiveSandbox ?? undefined);
  const writes: { scope: string; patch: { sandbox?: unknown } }[] = [];
  const notes: string[] = [];
  const settings = {
    version: () => 0,
    read: (scope: "global" | "workspace") =>
      scopes[scope] ? { sandbox: scopes[scope] } : undefined,
    effective: () => ({ sandbox: effectiveSandbox }),
    origin: () => (scopes.workspace ? "workspace" : scopes.global ? "global" : undefined),
    withheldWorkspaceFields: () => [],
    write: async (scope: string, patch: { sandbox?: unknown }) => {
      writes.push({ scope, patch });
    },
    inspectSandbox: (o?: { refresh?: boolean }) => {
      inspections.push(o?.refresh ?? false);
      return opts.inspect ? opts.inspect(o?.refresh) : Promise.resolve(INSPECTION);
    },
  } as unknown as SettingsAdapter;
  const deps = { settings, notify: (m: string) => notes.push(m) };
  return { host, controls, deps, press, inspections, writes, notes };
}

function bigInspection(count: number): SandboxInspection {
  const ids = [
    "bun",
    "node",
    "python3",
    "python",
    "rust",
    "go",
    "java",
    "dotnet",
    "ruby",
    "deno",
    "php",
    "zig",
    "c-cpp",
    "kotlin",
    "swift",
  ];
  return {
    bubblewrap: { available: true, mode: "fresh-proc", degraded: false },
    toolchains: ids.slice(0, count).map((id, i) => ({
      id,
      commands: [id],
      available: i < 3,
      enabled: true,
      scope: "auto",
      manager: "mise",
      version: i < 3 ? "1.0.0" : undefined,
    })),
    extra_paths: [],
    effective_path: [],
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("ctrl+r refreshes the toolchain inspection; bare r no longer does", async () => {
  const { host, deps, press, inspections } = mount();
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 30,
  });
  await tick();
  await t.renderOnce();
  expect(inspections).toEqual([false]);
  press("r");
  await tick();
  expect(inspections).toEqual([false]);
  press("ctrl+r");
  await tick();
  expect(inspections).toEqual([false, true]);
  expect(t.captureCharFrame()).toContain("[^r] refresh");
  t.renderer.destroy();
});

test("a slower inspection cannot replace a newer refresh response", async () => {
  let resolveInitial!: (inspection: SandboxInspection) => void;
  let resolveRefresh!: (inspection: SandboxInspection) => void;
  const { host, deps, press } = mount({
    inspect: (refresh) =>
      new Promise<SandboxInspection>((resolve) => {
        if (refresh) resolveRefresh = resolve;
        else resolveInitial = resolve;
      }),
  });
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 30,
  });
  await t.renderOnce();
  press("ctrl+r");
  resolveRefresh(UNAVAILABLE_INSPECTION);
  await tick();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("not installed");

  resolveInitial(INSPECTION);
  await tick();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("not installed");
  t.renderer.destroy();
});

test("the editable policy uses product labels and names the mutation affordance", async () => {
  const { host, deps } = mount();
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 30,
  });
  await tick();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Sandbox  on · global · next run");
  expect(frame).toContain("Host availability  required · from product default · next run");
  expect(frame).toContain("Workspace access  workspace-write · from product default · next run");
  expect(frame).toContain("Network access  host · from product default · next run");
  expect(frame).toContain("Toolchain discovery  auto · from product default · next run");
  expect(frame).toContain("change Sandbox");
  t.renderer.destroy();
});

test("enter on an enum field opens the pick surface pre-selected, no blind cycling", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 34,
  });
  await tick();
  await t.renderOnce();
  press("down");
  press("return");
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("availability");
  expect(frame).toContain("required");
  expect(frame).toContain("optional");
  t.renderer.destroy();
});

test("effective policy, host diagnosis, and toolchain inventory have distinct owners", async () => {
  const { host, deps } = mount();
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 30,
  });
  await tick();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame.indexOf("effective")).toBeLessThan(frame.indexOf("Sandbox  on"));
  expect(frame.indexOf("host")).toBeLessThan(frame.indexOf("Toolchains on kernel host"));
  expect(frame).toContain("Tool       Version             Manager   Source     State");
  t.renderer.destroy();
});

test("the Bubblewrap probe routes through the shared loading hint while pending", async () => {
  const { host, deps } = mount({ inspect: () => new Promise<SandboxInspection>(() => {}) });
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 30,
  });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("checking Bubblewrap on kernel host…");
  expect(frame).toContain("discovering toolchains…");
  t.renderer.destroy();
});

test("short terminal: the toolchain list scrolls; nothing bleeds past the footer onto the shell", async () => {
  const { host, deps } = mount({ inspect: () => Promise.resolve(bigInspection(15)) });
  const t = await openRender(
    (() => (
      <box flexDirection="column">
        <text>SHELL-HEADER</text>
        <box height={20}>{SandboxConfigPanel(host, deps)}</box>
        <text>SHELL-FOOTER-SENTINEL</text>
      </box>
    )) as never,
    { width: 120, height: 40 },
  );
  await tick();
  await t.renderOnce();
  await t.renderOnce();
  const lines = t
    .captureCharFrame()
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));
  const footerIdx = lines.findIndex((l) => l.includes("toggle / edit"));
  expect(footerIdx).toBeGreaterThan(0);
  const below = lines.slice(footerIdx + 1);
  for (const tc of ["swift", "kotlin", "python", "rust", "mise"]) {
    expect(below.some((l) => l.includes(tc))).toBe(false);
  }
  expect(below.some((l) => l.trim() === "SHELL-FOOTER-SENTINEL")).toBe(true);
  t.renderer.destroy();
});

test("a failed inspection surfaces the error in the banner and in the host status line", async () => {
  const { host, deps } = mount({ inspect: () => Promise.reject(new Error("probe failed")) });
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 30,
  });
  await tick();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Bubblewrap Error: probe failed");
  expect(frame).toContain("Error: probe failed");
  t.renderer.destroy();
});

test("no sandbox block: the fallback row renders and enabling creates a default block, warning when Bubblewrap is unavailable", async () => {
  const { host, deps, press, notes } = mount({
    readSandbox: null,
    effectiveSandbox: null,
    inspect: () => Promise.resolve(UNAVAILABLE_INSPECTION),
  });
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 30,
  });
  await tick();
  await t.renderOnce();
  let frame = t.captureCharFrame();
  expect(frame).toContain("Sandbox  off · from product default · next run");
  expect(frame).toContain("[↵] enable");
  expect(host.dirty()).toBe(false);
  press("return");
  await t.renderOnce();
  expect(host.dirty()).toBe(true);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("Bubblewrap is not installed here");
  expect(notes[0]).toContain("required");
  frame = t.captureCharFrame();
  expect(frame).toContain("Sandbox  off · configured on · product default · next run");
  expect(frame).toContain("toggle / edit");
  t.renderer.destroy();
});

test("creating a block when Bubblewrap is available does not warn", async () => {
  const { host, deps, press, notes } = mount({ readSandbox: null, effectiveSandbox: null });
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 30,
  });
  await tick();
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  expect(notes).toEqual([]);
  t.renderer.destroy();
});

test("removing the block via 'x' clears the draft, dirties the host, and notifies", async () => {
  const { host, deps, press, notes } = mount();
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 30,
  });
  await tick();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Sandbox  on · global · next run");
  press("x");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Sandbox  on · from global · next run");
  expect(host.dirty()).toBe(true);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("sandbox block removed from the global draft");
  t.renderer.destroy();
});

test("toggling 'enabled' on row 0 flips the draft and dirties the host", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 30,
  });
  await tick();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain(" on ");
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain(" off");
  expect(host.dirty()).toBe(true);
  t.renderer.destroy();
});

test("changing availability stages the configured value without relabeling it effective", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 34,
  });
  await tick();
  await t.renderOnce();
  press("down");
  press("return");
  await t.renderOnce();
  press("down");
  press("return");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Configured here: optional");
  expect(frame).toContain("Effective:       required");
  expect(frame).toContain("Source:          product default");
  t.renderer.destroy();
});

test("changing network stages the configured value without relabeling it effective", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 34,
  });
  await tick();
  await t.renderOnce();
  press("down");
  press("down");
  press("down");
  press("return");
  await t.renderOnce();
  press("down");
  press("return");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Configured here: none");
  expect(frame).toContain("Effective:       host");
  expect(frame).toContain("Source:          product default");
  t.renderer.destroy();
});

test("changing filesystem stages the configured value without relabeling it effective", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 34,
  });
  await tick();
  await t.renderOnce();
  press("down");
  press("down");
  press("return");
  await t.renderOnce();
  press("down");
  press("return");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Configured here: workspace-read-only");
  expect(frame).toContain("Effective:       workspace-write");
  expect(frame).toContain("Source:          product default");
  t.renderer.destroy();
});

test("changing toolchain mode stages the configured value without relabeling it effective", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 34,
  });
  await tick();
  await t.renderOnce();
  press("down");
  press("down");
  press("down");
  press("down");
  press("down");
  press("return");
  await t.renderOnce();
  press("down");
  press("return");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Configured here: manual");
  expect(frame).toContain("Effective:       auto");
  expect(frame).toContain("Source:          product default");
  t.renderer.destroy();
});

test("ctrl+s save() writes the draft under the current scope and clears dirty", async () => {
  const { host, controls, deps, writes, notes } = mount();
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 30,
  });
  await tick();
  await t.renderOnce();
  host.markDirty(true);
  await controls.runSave();
  expect(writes).toEqual([{ scope: "global", patch: { sandbox: SANDBOX } }]);
  expect(host.dirty()).toBe(false);
  expect(notes).toContain("saved global sandbox config");
  t.renderer.destroy();
});

test("host warning: required + unavailable says runs will fail", async () => {
  const { host, deps } = mount({
    readSandbox: { ...SANDBOX, availability: "required" },
    effectiveSandbox: { ...SANDBOX, availability: "required" },
    inspect: () => Promise.resolve(UNAVAILABLE_INSPECTION),
  });
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 160,
    height: 30,
  });
  await tick();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("unavailable here (not installed)");
  expect(frame).toContain("runs will fail; set availability to optional or disable");
  t.renderer.destroy();
});

test("host warning: optional + unavailable says commands run directly", async () => {
  const { host, deps } = mount({
    readSandbox: { ...SANDBOX, availability: "optional" },
    effectiveSandbox: { ...SANDBOX, availability: "optional" },
    inspect: () => Promise.resolve(UNAVAILABLE_INSPECTION),
  });
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 30,
  });
  await tick();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("commands run directly");
  t.renderer.destroy();
});

test("host warning: degraded mode is reported even though it is still available", async () => {
  const { host, deps } = mount({ inspect: () => Promise.resolve(DEGRADED_INSPECTION) });
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 30,
  });
  await tick();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("degraded mode: the sandbox shares the host /proc");
  expect(frame).toContain("degraded: shares host /proc");
  t.renderer.destroy();
});

test("effective status: no block anywhere reads as off", async () => {
  const { host, deps } = mount({ effectiveSandbox: null });
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 30,
  });
  await tick();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("off — commands run directly on the host");
  t.renderer.destroy();
});

test("effective status: explicitly disabled reads as off", async () => {
  const { host, deps } = mount({ effectiveSandbox: { ...SANDBOX, enabled: false } });
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 30,
  });
  await tick();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("off — commands run directly on the host");
  t.renderer.destroy();
});

test("effective status: optional availability notes the fallback", async () => {
  const { host, deps } = mount({ effectiveSandbox: { ...SANDBOX, availability: "optional" } });
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 30,
  });
  await tick();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("(falls back to direct)");
  t.renderer.destroy();
});

test("workspace policy rows identify workspace provenance", async () => {
  const { host, deps } = mount({
    initialScope: "workspace",
    readSandbox: {
      ...SANDBOX,
      toolchains: { extra_paths: ["/opt/workspace/bin"] },
    },
    effectiveSandbox: {
      ...SANDBOX,
      toolchains: { extra_paths: ["/opt/workspace/bin"] },
    },
  });
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 130,
    height: 34,
  });
  await tick();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain(
    "Additional toolchain paths  /opt/workspace/bin · workspace · next run",
  );
  t.renderer.destroy();
});

test("sandbox rows project scalar inheritance and union-list provenance field by field", async () => {
  const global: NonNullable<SettingsFile["sandbox"]> = {
    type: "bubblewrap",
    availability: "optional",
    pass_env: ["GLOBAL_TOKEN"],
  };
  const workspace: NonNullable<SettingsFile["sandbox"]> = {
    type: "bubblewrap",
    enabled: true,
    pass_env: ["WORKSPACE_TOKEN"],
  };
  const { host, deps, press } = mount({
    initialScope: "workspace",
    scopes: { global, workspace },
    effectiveSandbox: {
      type: "bubblewrap",
      enabled: true,
      availability: "optional",
      pass_env: ["GLOBAL_TOKEN", "WORKSPACE_TOKEN"],
    },
  });
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 130,
    height: 34,
  });
  await tick();
  await t.renderOnce();

  press("down");
  await t.renderOnce();
  let frame = t.captureCharFrame();
  expect(frame).toContain("Configured here: inherit");
  expect(frame).toContain("Effective:       optional");
  expect(frame).toContain("Source:          global");

  for (let index = 0; index < 3; index++) press("down");
  await t.renderOnce();
  frame = t.captureCharFrame();
  expect(frame).toContain("Configured here: WORKSPACE_TOKEN");
  expect(frame).toContain("Effective:       GLOBAL_TOKEN WORKSPACE_TOKEN");
  expect(frame).toContain("Source:          global + workspace");
  t.renderer.destroy();
});

test("text fields (pass_env) open the shared editor pre-filled and escape cancels without dirtying", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 34,
  });
  await tick();
  await t.renderOnce();
  press("down");
  press("down");
  press("down");
  press("down");
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("pass_env (space-separated)");
  expect(host.dirty()).toBe(false);
  press("escape");
  await t.renderOnce();
  expect(host.dirty()).toBe(false);
  t.renderer.destroy();
});

test("pass_env refuses a name no environment could carry", async () => {
  // The allow-list is passed to a child process by name, so an entry that is not
  // a legal name can never match anything. It used to be persisted unchecked
  // while the strict fields next to it validated.
  const { host, deps, press, notes } = mount();
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 34,
  });
  await tick();
  await t.renderOnce();
  for (let i = 0; i < 4; i++) press("down");
  press("return");
  await t.renderOnce();
  await t.mockInput.typeText("GOOD_ONE 1BAD not-a-name");
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  expect(notes.at(-1)).toContain("not valid environment variable names");
  expect(notes.at(-1)).toContain("1BAD");
  expect(host.dirty()).toBe(false);
  t.renderer.destroy();
});

test("pass_env accepts a list of legal names", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 34,
  });
  await tick();
  await t.renderOnce();
  for (let i = 0; i < 4; i++) press("down");
  press("return");
  await t.renderOnce();
  await t.mockInput.typeText("GOOD_ONE _OTHER2");
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  expect(host.dirty()).toBe(true);
  t.renderer.destroy();
});

test("include/exclude/extra-paths text fields each open the shared editor pre-filled with their label", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 34,
  });
  await tick();
  await t.renderOnce();
  for (let i = 0; i < 6; i++) press("down");
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("toolchains include (space-separated; blank = defaults)");
  press("escape");
  await t.renderOnce();
  press("down");
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("toolchains exclude (space-separated)");
  press("escape");
  await t.renderOnce();
  press("down");
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("extra toolchain paths (space-separated)");
  expect(host.dirty()).toBe(false);
  t.renderer.destroy();
});

test("with no toolchain/extra-path rows the scrollbox is simply empty", async () => {
  const { host, deps } = mount();
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 110,
    height: 30,
  });
  await tick();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Toolchains on kernel host");
  t.renderer.destroy();
});

test("unavailable toolchains stay collapsed even when the terminal is tall", async () => {
  const { host, deps } = mount({ inspect: () => Promise.resolve(bigInspection(15)) });
  const t = await openRender((() => SandboxConfigPanel(host, deps)) as never, {
    width: 120,
    height: 44,
  });
  await tick();
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("bun");
  expect(frame).not.toContain("swift");
  expect(frame).not.toContain("kotlin");
  // Lower-case: `u` is the key that dispatches, and the hint advertised `U`.
  expect(frame).toContain("12 unavailable hidden · u show unavailable");
  t.renderer.destroy();
});
