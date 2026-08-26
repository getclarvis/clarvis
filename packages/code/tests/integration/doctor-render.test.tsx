import type { JSX } from "solid-js";
import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import type { Interaction } from "../../src/keys/interaction.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { DoctorView, type DoctorViewDeps } from "../../src/views/config/DoctorView.tsx";
import type { DoctorCtx, DoctorReport, Gate, GateResult } from "../../src/onboarding/doctor.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const fakeKeymap = createFakeKeymap;

const pass: GateResult = { status: "pass", detail: "ok" };

function gate(id: Gate["id"], label: string, severity: Gate["severity"]): Gate {
  return { id, label, severity, check: () => pass };
}

const GATES: Gate[] = [
  gate("config", "config", "hard"),
  gate("providers", "providers", "soft"),
  gate("theme", "theme", "ui"),
  gate("backend", "backend", "comms"),
];

function report(results: Partial<Record<Gate["id"], GateResult>>): DoctorReport {
  const filled = Object.fromEntries(GATES.map((g) => [g.id, results[g.id] ?? pass]));
  return { gates: GATES, results: filled as DoctorReport["results"], blocked: false };
}

function mount(rep: DoctorReport, opts?: { boot?: boolean; ctx?: DoctorCtx }) {
  const { keymap, press } = fakeKeymap();
  const notes: string[] = [];
  const dispatched: string[] = [];
  let started = 0;
  let closed = 0;
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {
      closed++;
    },
    dispatch: (name) => dispatched.push(name),
  });
  const deps: DoctorViewDeps = {
    ctx: opts?.ctx ?? ({} as DoctorCtx),
    report: () => rep,
    recheck: () => {},
    openFix: () => {},
    startAnyway: () => {
      started++;
    },
    keys: { set: () => {} } as never,
    notify: (m) => notes.push(m),
    ...(opts?.boot !== undefined ? { boot: opts.boot } : {}),
  };
  return {
    host,
    deps,
    press,
    notes,
    dispatched,
    started: () => started,
    closed: () => closed,
  };
}

test("mixed pass/fail: issues lead and the selected actionable row shows its hint", async () => {
  const rep = report({
    providers: { status: "warn", detail: "none declared", hint: "add one from the catalog" },
    theme: { status: "warn", detail: "defaults" },
  });
  const { host, deps } = mount(rep);
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Needs attention · 1 check");
  expect(frame).toContain("Recommendations · 1 optional");
  expect(frame).toContain("→ add one from the catalog");
  expect(frame).toContain("[g] back");
  expect(frame).toContain("[^r] refresh");
  expect(frame).toContain("[-] skip");
  expect(frame).toContain("recommended items pending");
  t.renderer.destroy();
});

test("all-pass collapses healthy detail into one readiness summary", async () => {
  const { host, deps } = mount(report({}));
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("4 configuration checks passed");
  expect(frame).not.toContain("config: ok");
  expect(frame).not.toContain("[↵] resolve");
  t.renderer.destroy();
});

test("healthy Doctor evidence expands on demand and collapses again", async () => {
  const { host, deps, press } = mount(report({}));
  const t = await openRender((() => DoctorView(host, deps)) as never, {
    width: 110,
    height: 30,
  });
  await t.renderOnce();
  press("d");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Healthy checks");
  expect(t.captureCharFrame()).toContain("config: ok");
  expect(t.captureCharFrame()).toContain("backend: ok");

  press("d");
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("config: ok");
  t.renderer.destroy();
});

test("[-] skips the selected soft gate; recheck reselect lands on next non-pass", async () => {
  const rep = report({
    providers: { status: "warn", detail: "none declared" },
    theme: { status: "warn", detail: "defaults" },
  });
  const { host, deps, press, notes } = mount(rep);
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("-");
  await t.renderOnce();
  expect(notes.some((n) => n.includes("skipped: providers"))).toBe(true);
  expect(t.captureCharFrame()).toContain("3 configuration checks passed");
  expect(t.captureCharFrame()).toContain("Recommendations · 1 optional");
  expect(t.captureCharFrame()).toContain("theme: defaults");
  t.renderer.destroy();
});

test("[c] reconnects the backend and [u] refreshes the model catalog, both via host.dispatch", async () => {
  const { host, deps, press, dispatched } = mount(report({}));
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("[c] reconnect backend");
  expect(t.captureCharFrame()).toContain("[u] refresh model catalog");
  press("c");
  press("u");
  expect(dispatched).toEqual(["backend.reconnect", "catalog.refresh"]);
  t.renderer.destroy();
});

test("opened manually, esc closes the view even under a required failure", async () => {
  const rep = report({ config: { status: "fail", detail: "no settings.json" } });
  const { host, deps, press, started, closed } = mount(rep);
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("escape");
  expect(closed()).toBe(1);
  expect(started()).toBe(0);
  t.renderer.destroy();
});

test("blocking boot with only recommended pending: esc returns to recovery", async () => {
  const rep = report({ providers: { status: "warn", detail: "none declared" } });
  const { host, deps, press, started, closed } = mount(rep, { boot: true });
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("escape");
  expect(started()).toBe(0);
  expect(closed()).toBe(1);
  t.renderer.destroy();
});

test("blocking boot with a required failure: esc returns without offering quit", async () => {
  const rep = report({ config: { status: "fail", detail: "no settings.json" } });
  const { host, deps, press, started, closed, dispatched } = mount(rep, { boot: true });
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("[q] quit");
  press("escape");
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("quit clarvis?");
  expect(dispatched).not.toContain("app.quit");
  expect(started()).toBe(0);
  expect(closed()).toBe(1);
  t.renderer.destroy();
});

test("the corrupt config gate repairs only behind an explicit confirm", async () => {
  let applied = 0;
  const ctx = {
    settings: {
      knownGrants: () => undefined,
      planRepair: () => ({
        scope: "global",
        path: "/home/u/.clarvis/settings.json",
        revision: "preview-revision",
        action: "strip",
        dropped: ["stale_key"],
      }),
      applyRepair: async () => {
        applied++;
      },
    },
  } as unknown as DoctorCtx;
  const rep = report({
    config: {
      status: "fail",
      detail: 'invalid /home/u/.clarvis/settings.json: (root): Unrecognized key: "stale_key"',
      fix: { kind: "repair-settings", scope: "global" },
    },
  });
  const { host, deps, press, notes } = mount(rep, { ctx });
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("strip invalid keys from global settings.json?");
  expect(applied).toBe(0);
  press("y");
  await t.renderOnce();
  await t.renderOnce();
  expect(applied).toBe(1);
  expect(notes.some((n) => n.includes("settings repaired"))).toBe(true);
  t.renderer.destroy();
});

test("the real keymap parses a bare '-' binding and fires it", async () => {
  const t = await openRender((() => <text>probe</text>) as never, { width: 20, height: 4 });
  const keymap = createDefaultOpenTuiKeymap(t.renderer);
  let fired = 0;
  const off = keymap.registerLayer({
    priority: 900,
    bindings: [
      {
        key: "-",
        cmd: () => {
          fired++;
        },
      },
    ],
  });
  await t.renderOnce();
  await t.mockInput.typeText("-");
  await t.renderOnce();
  expect(fired).toBe(1);
  off();
  t.renderer.destroy();
});

const FULL_GATES: Gate[] = [
  gate("config", "config", "hard"),
  gate("agents", "agents", "hard"),
  gate("providers", "provider", "soft"),
  gate("credentials", "credential", "soft"),
  gate("default_model", "default model", "soft"),
  gate("default_agent", "default agent", "ui"),
  gate("theme", "theme", "ui"),
  gate("run_safety", "run safety", "ui"),
  gate("memory", "memory", "comms"),
  gate("backend", "backend", "comms"),
];

function fullReport(): DoctorReport {
  const filled = Object.fromEntries(FULL_GATES.map((g) => [g.id, pass]));
  return { gates: FULL_GATES, results: filled as DoctorReport["results"], blocked: false };
}

function fullReportWith(results: Partial<Record<Gate["id"], GateResult>>): DoctorReport {
  const filled = Object.fromEntries(FULL_GATES.map((g) => [g.id, results[g.id] ?? pass]));
  return { gates: FULL_GATES, results: filled as DoctorReport["results"], blocked: false };
}

function renderInShell(
  view: () => JSX.Element,
  opts: { slot: number; width?: number; height?: number },
) {
  return openRender(
    (() => (
      <box flexDirection="column">
        <text>SHELL-HEADER</text>
        <box height={opts.slot}>{view()}</box>
        <text>SHELL-FOOTER-SENTINEL</text>
      </box>
    )) as never,
    { width: opts.width ?? 120, height: opts.height ?? 40 },
  );
}

test("short terminal: the gate list scrolls; nothing bleeds past the footer onto the shell", async () => {
  const { host, deps } = mount(fullReport());
  const t = await renderInShell(() => DoctorView(host, deps), { slot: 16 });
  await t.renderOnce();
  await t.renderOnce();
  const lines = t
    .captureCharFrame()
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));
  const footerIdx = lines.findIndex((l) => l.includes("[g] back"));
  expect(footerIdx).toBeGreaterThan(0);
  expect(t.captureCharFrame()).toContain("10 configuration checks passed");
  const below = lines.slice(footerIdx + 1);
  for (const gate of ["config", "agents", "provider", "memory", "backend", "run safety"]) {
    expect(below.some((l) => l.includes(gate))).toBe(false);
  }
  expect(below.some((l) => l.trim() === "SHELL-FOOTER-SENTINEL")).toBe(true);
  t.renderer.destroy();
});

function fullCtx(over: Partial<DoctorCtx> = {}): DoctorCtx {
  return {
    settings: {
      knownGrants: () => undefined,
      effective: () => ({
        providers: [{ name: "openrouter", kind: "openai-compatible", models: {} }],
      }),
      envStatus: () => "unset",
      planRepair: () => null,
      applyRepair: async () => {},
    },
    agents: {
      list: () => [
        {
          name: "reviewer",
          scope: "global",
          frontmatter: { model: "openrouter/glm-5.2" },
          body: "",
        },
      ],
      conflicts: () => [],
    },
    code: { writeAgentDefault: () => {} },
    env: {
      budgetOnExceed: "escalate",
      iterationDefault: 50,
      iterationCeiling: 100,
      tokenDefault: 4_000_000,
      tokenCeiling: 5_000_000,
      maxGrant: "edit",
      contextWindowDefault: 128000,
    },
    ...over,
  } as unknown as DoctorCtx;
}

test("a gate with no action is status-only and Enter does not pretend it can fix it", async () => {
  const { host, deps, press, notes } = mount(report({}));
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  expect(notes).toEqual([]);
  t.renderer.destroy();
});

test("fixFocused: a 'view' fix opens the named panel at the host's current scope", async () => {
  const rep = report({
    theme: { status: "warn", detail: "defaults", fix: { kind: "view", view: "theme" } },
  });
  const opened: [string, unknown][] = [];
  const { host, deps, press } = mount(rep);
  deps.openFix = (view, scope) => opened.push([view, scope]);
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("return");
  expect(opened).toEqual([["theme", "global"]]);
  t.renderer.destroy();
});

test("fixFocused: a 'reconnect' fix dispatches backend.reconnect", async () => {
  const rep = report({
    theme: { status: "warn", detail: "defaults", fix: { kind: "reconnect" } },
  });
  const { host, deps, press, dispatched } = mount(rep);
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("return");
  expect(dispatched).toEqual(["backend.reconnect"]);
  t.renderer.destroy();
});

test("fixFocused: a 'set-default' fix picks the first runnable agent and writes it", async () => {
  const rep = report({
    theme: { status: "warn", detail: "unset", fix: { kind: "set-default" } },
  });
  const written: [string, string][] = [];
  const ctx = fullCtx({
    code: {
      writeAgentDefault: (scope: string, name: string) => written.push([scope, name]),
    } as never,
  });
  const { host, deps, press, notes } = mount(rep, { ctx });
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("return");
  expect(written).toEqual([["global", "reviewer"]]);
  expect(notes).toEqual(["default agent: reviewer (global)"]);
  t.renderer.destroy();
});

test("fixFocused: a 'set-default' fix with no agents at all just says so", async () => {
  const rep = report({
    theme: { status: "warn", detail: "unset", fix: { kind: "set-default" } },
  });
  const ctx = fullCtx({
    agents: {
      list: () => [],
      conflicts: () => [],
    },
  });
  const { host, deps, press, notes } = mount(rep, { ctx });
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("return");
  expect(notes).toEqual(["no agent to set"]);
  t.renderer.destroy();
});

test("fixFocused: a 'set-default' fix that fails to write notifies the error", async () => {
  const rep = report({
    theme: { status: "warn", detail: "unset", fix: { kind: "set-default" } },
  });
  const ctx = fullCtx({
    code: {
      writeAgentDefault: () => {
        throw new Error("readonly fs");
      },
    } as never,
  });
  const { host, deps, press, notes } = mount(rep, { ctx });
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("return");
  expect(notes).toEqual(["set default failed: readonly fs"]);
  t.renderer.destroy();
});

test("fixFocused: a 'set-key' fix with no missing credentials just says so", async () => {
  const rep = report({
    theme: { status: "warn", detail: "unset", fix: { kind: "set-key" } },
  });
  const ctx = fullCtx();
  const { host, deps, press, notes } = mount(rep, { ctx });
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("return");
  expect(notes).toEqual(["no missing credentials"]);
  t.renderer.destroy();
});

test("fixFocused: a 'set-key' fix with one missing credential opens the secret editor directly, and a save failure notifies", async () => {
  const rep = report({
    theme: { status: "warn", detail: "unset", fix: { kind: "set-key" } },
  });
  const ctx = fullCtx({
    settings: {
      knownGrants: () => undefined,
      effective: () => ({
        providers: [
          {
            name: "openrouter",
            kind: "openai-compatible",
            api_key_env: "OPENROUTER_KEY",
            models: {},
          },
        ],
      }),
      envStatus: () => "unset",
      planRepair: () => null,
      applyRepair: async () => {},
    } as never,
  });
  const { host, deps, press, notes, dispatched } = mount(rep, { ctx });
  deps.keys = { set: async () => Promise.reject(new Error("vault locked")) } as never;
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("API key");
  expect(t.captureCharFrame()).toContain("OPENROUTER_KEY");
  await t.mockInput.typeText("sk-live-123");
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  await Promise.resolve();
  await Promise.resolve();
  expect(notes.some((n) => n.includes("key save failed: vault locked"))).toBe(true);
  expect(dispatched).not.toContain("backend.reconnect");
  t.renderer.destroy();
});

test("fixFocused: a 'set-key' fix with one missing credential saves it, rechecks, and reconnects", async () => {
  const rep = report({
    theme: { status: "warn", detail: "unset", fix: { kind: "set-key" } },
  });
  const ctx = fullCtx({
    settings: {
      knownGrants: () => undefined,
      effective: () => ({
        providers: [
          {
            name: "openrouter",
            kind: "openai-compatible",
            api_key_env: "OPENROUTER_KEY",
            models: {},
          },
        ],
      }),
      envStatus: () => "unset",
      planRepair: () => null,
      applyRepair: async () => {},
    } as never,
  });
  const saved: [string, string][] = [];
  let rechecked = 0;
  const { host, deps, press, notes, dispatched } = mount(rep, { ctx });
  deps.keys = {
    set: async (name: string, value: string) => void saved.push([name, value]),
  } as never;
  deps.recheck = () => {
    rechecked++;
  };
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  await t.mockInput.typeText("sk-live-123");
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  await Promise.resolve();
  await Promise.resolve();
  expect(saved).toEqual([["OPENROUTER_KEY", "sk-live-123"]]);
  expect(rechecked).toBe(1);
  expect(dispatched).toContain("backend.reconnect");
  expect(notes.some((n) => n.includes("key saved"))).toBe(true);
  t.renderer.destroy();
});

test("fixFocused: a 'set-key' fix with several missing credentials offers a picker first", async () => {
  const rep = report({
    theme: { status: "warn", detail: "unset", fix: { kind: "set-key" } },
  });
  const ctx = fullCtx({
    settings: {
      knownGrants: () => undefined,
      effective: () => ({
        providers: [
          {
            name: "openrouter",
            kind: "openai-compatible",
            api_key_env: "OPENROUTER_KEY",
            models: {},
          },
          { name: "together", kind: "openai-compatible", api_key_env: "TOGETHER_KEY", models: {} },
        ],
      }),
      envStatus: () => "unset",
      planRepair: () => null,
      applyRepair: async () => {},
    } as never,
  });
  const { host, deps, press } = mount(rep, { ctx });
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("which credential");
  expect(frame).toContain("TOGETHER_KEY");
  t.renderer.destroy();
});

test("doRepairSettings: a valid config has nothing to repair, and rechecks anyway", async () => {
  const ctx = fullCtx({
    settings: {
      knownGrants: () => undefined,
      effective: () => ({ providers: [] }),
      envStatus: () => "unset",
      planRepair: () => null,
      applyRepair: async () => {},
    } as never,
  });
  const rep = report({
    config: {
      status: "fail",
      detail: "corrupt",
      fix: { kind: "repair-settings", scope: "global" },
    },
  });
  let rechecked = 0;
  const { host, deps, press, notes } = mount(rep, { ctx });
  deps.recheck = () => {
    rechecked++;
  };
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  expect(notes).toEqual(["settings are valid — nothing to repair"]);
  expect(rechecked).toBe(1);
  t.renderer.destroy();
});

test("doRepairSettings: declining the confirm ('n') leaves the settings untouched", async () => {
  let applied = 0;
  const ctx = fullCtx({
    settings: {
      knownGrants: () => undefined,
      effective: () => ({ providers: [] }),
      envStatus: () => "unset",
      planRepair: () => ({
        scope: "global",
        path: "/home/u/.clarvis/settings.json",
        revision: "preview-revision",
        action: "strip",
        dropped: ["stale_key"],
      }),
      applyRepair: async () => {
        applied++;
      },
    } as never,
  });
  const rep = report({
    config: {
      status: "fail",
      detail: "corrupt",
      fix: { kind: "repair-settings", scope: "global" },
    },
  });
  const { host, deps, press } = mount(rep, { ctx });
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("strip invalid keys");
  press("n");
  await t.renderOnce();
  expect(applied).toBe(0);
  t.renderer.destroy();
});

test("doRepairSettings: an unparsable settings file offers a reset to {}, and a failed repair notifies", async () => {
  const ctx = fullCtx({
    settings: {
      knownGrants: () => undefined,
      effective: () => ({ providers: [] }),
      envStatus: () => "unset",
      planRepair: () => ({
        scope: "global",
        path: "/home/u/.clarvis/settings.json",
        revision: "preview-revision",
        action: "reset",
        reason: "not valid JSON",
      }),
      applyRepair: async () => {
        throw new Error("permission denied");
      },
    } as never,
  });
  const rep = report({
    config: {
      status: "fail",
      detail: "corrupt",
      fix: { kind: "repair-settings", scope: "global" },
    },
  });
  const { host, deps, press, notes } = mount(rep, { ctx });
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("reset global settings.json to {}");
  press("y");
  await t.renderOnce();
  await Promise.resolve();
  await Promise.resolve();
  expect(notes.some((n) => n.includes("repair failed: permission denied"))).toBe(true);
  t.renderer.destroy();
});

test("only unresolved actionable rows participate in Doctor navigation", async () => {
  // The [-] binding itself is only live over a soft-severity row (see its
  // `when`), so the only reachable branch inside skipFocused for a passing
  // gate is the early "already passes" return — landing sel on a hard/ui/comms
  // row would never even dispatch the key. credentials (soft, warn) is
  // auto-selected first; one [down] moves onto default_model (soft, pass).
  const rep = fullReportWith({ credentials: { status: "warn", detail: "missing" } });
  const { host, deps, press, notes } = mount(rep);
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("credential");
  press("down");
  press("-");
  await t.renderOnce();
  expect(notes).toEqual(["skipped: credential (this session only)"]);
  expect(t.captureCharFrame()).toContain("10 configuration checks passed");
  t.renderer.destroy();
});

test("start [g]: a hard failure blocks starting even when explicitly requested", async () => {
  const rep = report({ config: { status: "fail", detail: "no settings.json" } });
  const { host, deps, press, notes, started } = mount(rep, { boot: true });
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("g");
  expect(notes).toEqual(["required: resolve config and agents first"]);
  expect(started()).toBe(0);
  t.renderer.destroy();
});

test("start [g]: with no hard failure it starts, even mid-warning", async () => {
  const rep = report({ providers: { status: "warn", detail: "none" } });
  const { host, deps, press, started } = mount(rep, { boot: true });
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("g");
  expect(started()).toBe(1);
  t.renderer.destroy();
});

test("tall healthy Doctor still keeps checks collapsed", async () => {
  const { host, deps } = mount(fullReport());
  const t = await openRender((() => DoctorView(host, deps)) as never, { width: 120, height: 40 });
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("10 configuration checks passed");
  expect(frame).not.toContain("backend: ok");
  t.renderer.destroy();
});
