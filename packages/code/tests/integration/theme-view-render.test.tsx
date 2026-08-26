import { afterEach, expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { ThemeView } from "../../src/views/config/ThemeView.tsx";
import type { ThemePreview } from "../../src/theme/theme.ts";
import type { Platform } from "../../src/adapters/platform.ts";
import type { CodeConfigStore } from "../../src/adapters/code-config.ts";
import {
  parseColor,
  resolveTokens,
  setThemedMixBase,
  TERMINAL_BG,
  TOKEN_ORDER,
  type ThemeConfig,
} from "../../src/theme/model.ts";
import { applyResolvedTokens, SUBAGENT_ORDER } from "../../src/theme/tokens.ts";
import { contrastRatio } from "../../src/theme/contrast.ts";
import { applyAsciiMode } from "../../src/theme/glyphs.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

afterEach(() => {
  applyAsciiMode(false);
  applyResolvedTokens(resolveTokens(undefined, "dark"));
  setThemedMixBase(resolveTokens(undefined, "dark").bg);
});

const fakeKeymap = createFakeKeymap;

function resolvedMap(patch: Record<string, string> = {}): Record<string, unknown> {
  return {
    ...Object.fromEntries(TOKEN_ORDER.map((t) => [t, "#888888"])),
    ...Object.fromEntries(SUBAGENT_ORDER.map((n) => [n, "#888888"])),
    subagent: SUBAGENT_ORDER.map(() => "#888888"),
    ...patch,
  };
}

function fakePreview(opts?: {
  map?: Record<string, unknown>;
  source?: ThemeConfig;
  onSet?: (patch: { overrides?: Record<string, Record<string, string>> }) => void;
}): ThemePreview {
  const all = opts?.map ?? resolvedMap();
  return {
    source: () => opts?.source ?? { mode: "dark", preset: "family" },
    draft: () => null,
    set: (_scope: unknown, patch: never) => opts?.onSet?.(patch),
    reset: () => {},
    commit: async () => {},
    overridesAt: () => undefined,
    resolveToken: () => ({ value: "#888888", source: "family" }),
    resolveAll: () => all,
  } as unknown as ThemePreview;
}

function fakePlatform(): Platform {
  return {
    capabilities: { themeBg: () => "dark", colorDepth: () => "truecolor" },
    suspend: () => {},
    resume: () => {},
  } as unknown as Platform;
}

function fakeCode(): { store: CodeConfigStore; asciiWrites: boolean[] } {
  const asciiWrites: boolean[] = [];
  const store = {
    asciiEnabled: () => false,
    writeAscii: (_s: string, on: boolean) => {
      asciiWrites.push(on);
    },
  } as unknown as CodeConfigStore;
  return { store, asciiWrites };
}

function mount(preview: ThemePreview = fakePreview()) {
  const { keymap, press } = fakeKeymap();
  const notes: string[] = [];
  const { host, controls } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const { store, asciiWrites } = fakeCode();
  const deps = {
    preview,
    platform: fakePlatform(),
    code: store,
    notify: (m: string) => notes.push(m),
  };
  return { host, controls, deps, press, notes, asciiWrites };
}

test("main pane renders controls, tokens and the derived footer with [x] reset on a token row", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => ThemeView(host, deps)) as never, { width: 110, height: 34 });
  await t.renderOnce();
  press("down");
  press("down");
  press("down");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("mode");
  expect(frame).toContain("preset");
  expect(frame).toContain("background");
  expect(frame).toContain("specimen");
  expect(frame).toContain("agent ramp");
  expect(frame).toContain("[x] reset");
  t.renderer.destroy();
});

test("fix to AA validates the override against every surface the token is audited on", async () => {
  const writes: Record<string, string>[] = [];
  const preview = fakePreview({
    map: resolvedMap({ bg: "#ffffff", "bg-elev": "#f0f0f0", warn: "#dddddd" }),
    onSet: (patch) => writes.push(patch.overrides?.dark ?? {}),
  });
  const { host, deps, press } = mount(preview);
  const t = await openRender((() => ThemeView(host, deps)) as never, { width: 110, height: 40 });
  await t.renderOnce();
  press("end");
  press("up");
  press("up");
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("WCAG contrast");
  for (let i = 0; i < 5; i++) press("down");
  press("return");
  const nudged = writes[0]?.warn;
  expect(nudged).toBeDefined();
  const against = (bgHex: string): number =>
    contrastRatio(parseColor(nudged!)!, parseColor(bgHex)!);
  expect(against("#ffffff")).toBeGreaterThanOrEqual(4.5);
  expect(against("#f0f0f0")).toBeGreaterThanOrEqual(4.5);
  t.renderer.destroy();
});

test("the ascii toggle stages: live preview flips, write happens only on ^s", async () => {
  const { host, controls, deps, press, asciiWrites } = mount();
  const t = await openRender((() => ThemeView(host, deps)) as never, { width: 110, height: 34 });
  await t.renderOnce();
  press("end");
  press("return");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toMatch(/ascii\s+on/);
  expect(frame).not.toContain("(unsaved)");
  expect(frame).toContain("Unsaved");
  expect(asciiWrites).toEqual([]);
  expect(host.dirty()).toBe(true);
  await controls.runSave();
  expect(asciiWrites).toEqual([true]);
  applyAsciiMode(false);
  t.renderer.destroy();
});

test("mode is an enum field: Enter opens the pick preselected and commits the choice", async () => {
  const patches: Record<string, unknown>[] = [];
  const preview = fakePreview({ onSet: (p) => patches.push(p) });
  const { host, deps, press } = mount(preview);
  const t = await openRender((() => ThemeView(host, deps)) as never, { width: 110, height: 34 });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  await t.renderOnce();
  const pick = t.captureCharFrame();
  expect(pick).toContain("light");
  expect(pick).toContain("auto");
  press("down");
  press("return");
  await t.renderOnce();
  expect(patches.at(-1)).toEqual({ mode: "light" });
  expect(host.dirty()).toBe(true);
  t.renderer.destroy();
});

test("background is an enum field: Enter opens themed/terminal and commits the choice", async () => {
  const patches: Record<string, unknown>[] = [];
  const preview = fakePreview({ onSet: (p) => patches.push(p) });
  const { host, deps, press } = mount(preview);
  const t = await openRender((() => ThemeView(host, deps)) as never, { width: 110, height: 34 });
  await t.renderOnce();
  press("down");
  press("down");
  press("return");
  await t.renderOnce();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("terminal");
  press("down");
  press("return");
  await t.renderOnce();
  expect(patches.at(-1)).toEqual({ background: "terminal" });
  expect(host.dirty()).toBe(true);
  t.renderer.destroy();
});

test("the contrast audit declares it runs against the themed bg when terminal mode is on", async () => {
  const preview = fakePreview({
    source: { mode: "dark", preset: "family", background: "terminal" },
  });
  const { host, deps, press } = mount(preview);
  const t = await openRender((() => ThemeView(host, deps)) as never, { width: 130, height: 40 });
  await t.renderOnce();
  press("end");
  press("up");
  press("up");
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("audit vs themed bg (terminal bg unknown)");
  t.renderer.destroy();
});

test("terminal background renders: transparent bg token, washes still paint, no crash", async () => {
  const map = resolveTokens(undefined, "dark");
  setThemedMixBase(map.bg);
  applyResolvedTokens({ ...map, bg: TERMINAL_BG });
  const preview = fakePreview({
    source: { mode: "dark", preset: "family", background: "terminal" },
  });
  const { host, deps, press } = mount(preview);
  const t = await openRender((() => ThemeView(host, deps)) as never, { width: 130, height: 34 });
  await t.renderOnce();
  press("down");
  press("down");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("background");
  expect(frame).toContain("paints the terminal's own bg");
  t.renderer.destroy();
});

test("token swatch rows share FieldRow's value column and enum fields carry the caret", async () => {
  const { host, deps } = mount();
  const t = await openRender((() => ThemeView(host, deps)) as never, { width: 110, height: 34 });
  await t.renderOnce();
  const rows = t.captureCharFrame().split("\n");
  const presetRow = rows.find((r) => r.includes("preset"))!;
  const tokenRow = rows.find((r) => r.includes("bg-elev"))!;
  expect(presetRow).toContain("family  ▾");
  expect(tokenRow.indexOf("#888888")).toBe(presetRow.indexOf("family"));
  t.renderer.destroy();
});

test("the depth subview is marked read-only with a preview-only note", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => ThemeView(host, deps)) as never, { width: 110, height: 34 });
  await t.renderOnce();
  press("end");
  press("up");
  press("return");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Read-only");
  expect(frame).toContain("preview only — colors are quantized from your current tokens");
  t.renderer.destroy();
});
