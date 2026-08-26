import { createEffect, createMemo, type Accessor } from "solid-js";
import type { CodeConfigStore } from "../adapters/code-config.ts";
import { mergeEffectiveTheme, mergeThemeBlock } from "../adapters/code-config.ts";
import type { Scope } from "../keys/commands.ts";
import { applyResolvedTokens, type SubagentName, type TokenName } from "./tokens.ts";
import {
  resolveBackground,
  resolveMode,
  resolveToken,
  resolveTokens,
  setThemedMixBase,
  TERMINAL_BG,
  type PresetName,
  type ResolvedTokens,
  type ThemeBackground,
  type ThemeConfig,
  type ThemeMode,
  type TokenSource,
} from "./model.ts";

/** Host-provided facts {@link createTheme} needs but does not itself own. */
export interface ThemeCapabilities {
  themeBg(): ThemeMode;
}

/** The active, resolved theme: reactive mode/preset/background/tokens, applied as a side effect. */
export interface Theme {
  mode: Accessor<ThemeMode>;
  preset: Accessor<PresetName>;
  background: Accessor<ThemeBackground>;
  resolved: Accessor<ResolvedTokens>;
  resolvedFor(mode: ThemeMode): ResolvedTokens;
}

/**
 * Creates the reactive {@link Theme}: derives mode/tokens/background from
 * `source` and pushes resolved tokens into the global token signals as an effect.
 */
export function createTheme(caps: ThemeCapabilities, source: Accessor<ThemeConfig>): Theme {
  const mode = createMemo(() => resolveMode(source(), caps.themeBg()));
  const resolved = createMemo(() => resolveTokens(source(), mode()));
  const background = createMemo(() => resolveBackground(source()));
  createEffect(() => {
    const map = resolved();
    setThemedMixBase(map.bg);
    applyResolvedTokens(background() === "terminal" ? { ...map, bg: TERMINAL_BG } : map);
  });
  return {
    mode,
    preset: () => source().preset ?? "family",
    background,
    resolved,
    resolvedFor: (m) => resolveTokens(source(), m),
  };
}

/** Staged theme edits per scope, merged into an effective preview and committed or reset as a whole. */
export interface ThemePreview {
  source(): ThemeConfig;
  draft(): ThemeConfig | null;
  set(scope: Scope, patch: Partial<ThemeConfig>): void;
  reset(): void;
  commit(): Promise<void>;
  overridesAt(
    scope: Scope,
    mode: ThemeMode,
  ): Partial<Record<TokenName | SubagentName, string>> | undefined;
  resolveToken(
    token: TokenName,
    mode: ThemeMode,
    preset: PresetName,
  ): { value: string; source: TokenSource };
  resolveAll(mode: ThemeMode): ResolvedTokens;
}

interface DraftSignals {
  global: Accessor<ThemeConfig | null>;
  setGlobal: (v: ThemeConfig | null) => void;
  workspace: Accessor<ThemeConfig | null>;
  setWorkspace: (v: ThemeConfig | null) => void;
}

/**
 * Creates a {@link ThemePreview} over per-scope draft signals: edits merge
 * global+workspace drafts (falling back to the stored config) into one
 * effective preview, without touching disk until {@link ThemePreview.commit}.
 */
export function createThemePreview(code: CodeConfigStore, signals: DraftSignals): ThemePreview {
  const draftOf = (scope: Scope): ThemeConfig | null =>
    scope === "workspace" ? signals.workspace() : signals.global();
  const setDraft = (scope: Scope, v: ThemeConfig | null): void =>
    scope === "workspace" ? signals.setWorkspace(v) : signals.setGlobal(v);
  const effectiveOf = (scope: Scope): ThemeConfig => draftOf(scope) ?? code.themeAt(scope);

  function mergeEffective(): ThemeConfig {
    return mergeEffectiveTheme(effectiveOf("global"), effectiveOf("workspace"));
  }

  return {
    source: mergeEffective,
    draft: () => ((signals.global() ?? signals.workspace()) ? mergeEffective() : null),
    set: (scope, patch) => {
      const base = effectiveOf(scope);
      setDraft(scope, mergeThemeBlock(base, patch));
    },
    reset: () => {
      signals.setGlobal(null);
      signals.setWorkspace(null);
    },
    commit: async () => {
      const g = signals.global();
      const w = signals.workspace();
      if (g) code.writeTheme("global", g);
      if (w) code.writeTheme("workspace", w);
      signals.setGlobal(null);
      signals.setWorkspace(null);
    },
    overridesAt: (scope, mode) => effectiveOf(scope).overrides?.[mode],
    resolveToken: (token, mode, preset) =>
      resolveToken(
        token,
        mode,
        preset,
        effectiveOf("global").overrides?.[mode],
        effectiveOf("workspace").overrides?.[mode],
      ),
    resolveAll: (mode) => resolveTokens(mergeEffective(), mode),
  };
}
