import { writeFileAtomicSync } from "@clarvis/paths";
import { z } from "zod";
import { readJsonFile } from "@clarvis/kernel/config";
import { createSignal, type Accessor } from "solid-js";
import { glyph } from "../core/marks.ts";
import type { ThemeConfig, ThemeMode, TokenName } from "../core/theme-types.ts";
import type { ClarvisDirs } from "./agents.ts";
import type { KeySource } from "./provider-secrets.ts";
import type { Scope } from "../keys/commands.ts";
import type { GuardMode } from "./guard-mode.ts";
import {
  normalizeKeyboardConfig,
  type KeyboardConfig,
  type KeyboardEnvironmentConfig,
} from "../keys/keyboard-profile.ts";

/** `code`-owned display and input preferences. Never forwarded to the kernel. */
export interface CodeUiConfig extends Record<string, unknown> {
  ascii?: boolean;
  keyboard?: KeyboardConfig;
}

/** The shape of one scope's `code.json` — `code`'s own settings, layered global-then-workspace. */
export interface CodeConfig {
  theme?: ThemeConfig;
  agent?: { default?: string };
  guard?: { mode?: string };
  keySources?: Record<string, KeySource>;
  ui?: CodeUiConfig;
}

function coerceSource(value: unknown): KeySource {
  return value === "env" || value === "keyfile" ? value : "auto";
}

/** Reads and writes `code.json` at global/workspace scope, exposing the effective (merged) view. */
export interface CodeConfigStore {
  read(scope: Scope): CodeConfig;
  themeAt(scope: Scope): ThemeConfig;
  effectiveTheme: Accessor<ThemeConfig>;
  agentDefault: Accessor<string | undefined>;
  guardModeDefault: Accessor<GuardMode | undefined>;
  asciiEnabled: Accessor<boolean>;
  /** Global-only keyboard preferences for the current terminal path. */
  keyboardConfig: Accessor<KeyboardConfig>;
  keySources: Accessor<Record<string, KeySource>>;
  keySource(varName: string): KeySource;
  overrideSource(mode: ThemeMode, token: TokenName): "global" | "workspace" | null;
  write(scope: Scope, patch: Partial<CodeConfig>): void;
  writeAscii(scope: Scope, on: boolean): void;
  writeKeyboardEnvironment(
    environmentId: string,
    config: KeyboardEnvironmentConfig | undefined,
  ): void;
  writeTheme(scope: Scope, theme: ThemeConfig): void;
  writeAgentDefault(scope: Scope, name: string): void;
  clearAgentDefault(scope: Scope): void;
  writeKeySource(scope: Scope, varName: string, source: KeySource): void;
  hasWorkspace(): boolean;
}

const codeConfigSchema = z
  .unknown()
  .transform((v): CodeConfig => (v && typeof v === "object" ? (v as CodeConfig) : {}));

function loadFile(file: string | undefined): { config: CodeConfig; error?: string } {
  if (!file) return { config: {} };
  const r = readJsonFile(file, codeConfigSchema);
  if (r.ok) return { config: r.value };
  return r.missing === true ? { config: {} } : { config: {}, error: r.error };
}

function readFile(file: string | undefined): CodeConfig {
  return loadFile(file).config;
}

function writeCodeConfig(file: string, config: CodeConfig): void {
  writeFileAtomicSync(file, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Applies a partial theme `patch` on top of `base` for one scope.
 *
 * @remarks
 * `patch.overrides` merges per-mode, per-token: an explicit `undefined` value
 * deletes that token from the merged result (clearing an override) rather
 * than being treated as "unset, keep base".
 */
function mergeThemeBlock(base: ThemeConfig | undefined, patch: Partial<ThemeConfig>): ThemeConfig {
  const overrides = { ...(base?.overrides ?? {}) };
  if (patch.overrides) {
    for (const mode of Object.keys(patch.overrides) as ThemeMode[]) {
      const merged = { ...(overrides[mode] ?? {}) };
      for (const [token, value] of Object.entries(patch.overrides[mode] ?? {})) {
        if (value === undefined) delete merged[token as TokenName];
        else merged[token as TokenName] = value;
      }
      overrides[mode] = merged;
    }
  }
  return {
    mode: patch.mode ?? base?.mode,
    preset: patch.preset ?? base?.preset,
    background: patch.background ?? base?.background,
    overrides,
  };
}

/**
 * Merges global and workspace theme configs into the effective theme.
 *
 * @remarks Per-mode `overrides` merge key-by-key (workspace wins per token),
 *   while `mode`/`preset`/`background` each take the workspace value whole
 *   only if set, else fall back to global.
 */
export function mergeEffectiveTheme(g: ThemeConfig, w: ThemeConfig): ThemeConfig {
  const overrides: ThemeConfig["overrides"] = {};
  for (const mode of ["dark", "light"] as ThemeMode[]) {
    const merged: Partial<Record<TokenName, string>> = {};
    for (const layer of [g.overrides?.[mode], w.overrides?.[mode]]) {
      for (const [token, value] of Object.entries(layer ?? {})) {
        if (value !== undefined) merged[token as TokenName] = value;
      }
    }
    if (Object.keys(merged).length > 0) overrides[mode] = merged;
  }
  return {
    mode: w.mode ?? g.mode,
    preset: w.preset ?? g.preset,
    background: w.background ?? g.background,
    overrides,
  };
}

/**
 * The stored `keyboard.environments` map, ready to be written back.
 *
 * @param value - the raw `ui.keyboard` block as it sits on disk.
 * @returns a shallow copy of the stored entries, or an empty map when the block
 *   is absent or is not a version-1 object.
 * @remarks Read through {@link normalizeKeyboardConfig}, write through here.
 *   Normalizing on the write path turns the read path's deliberate leniency
 *   into data loss: an entry the normalizer skips whole — a `profile` value it
 *   does not recognise takes its bindings and verdicts with it — would be
 *   dropped from the file by the first unrelated save on another terminal path.
 *   Entries are copied verbatim rather than re-validated, because it is the read
 *   that decides what activates; a version this build does not know is the one
 *   case where merging is impossible, and it is replaced.
 */
function storedKeyboardEnvironments(value: unknown): Record<string, KeyboardEnvironmentConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as { version?: unknown; environments?: unknown };
  if (raw.version !== 1) return {};
  const stored = raw.environments;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  return { ...(stored as Record<string, KeyboardEnvironmentConfig>) };
}

/**
 * Builds a {@link CodeConfigStore} over `dirs`, caching each scope's parsed
 * `code.json` in a signal and re-reading from disk on every write to detect a
 * concurrent hand-edit.
 *
 * @throws {@link Error} from a write when the on-disk file at that scope
 *   fails to parse — the caller is told to fix it by hand rather than have it
 *   silently overwritten.
 */
export function createCodeConfigStore(dirs: ClarvisDirs): CodeConfigStore {
  const fileOf = (scope: Scope): string | undefined =>
    scope === "workspace" ? dirs.state?.codeConfigFile : dirs.global.codeConfigFile;
  const [global, setGlobal] = createSignal<CodeConfig>(readFile(fileOf("global")));
  const [workspace, setWorkspace] = createSignal<CodeConfig>(readFile(fileOf("workspace")));
  const rawOf = (scope: Scope): CodeConfig => (scope === "workspace" ? workspace() : global());

  function persist(scope: Scope, apply: (current: CodeConfig) => CodeConfig): void {
    const file = fileOf(scope);
    if (!file) return;
    const { config, error } = loadFile(file);
    if (error) throw new Error(`${error} ${glyph("emDash")} fix it by hand before saving`);
    const next = apply(config);
    writeCodeConfig(file, next);
    if (scope === "workspace") setWorkspace(next);
    else setGlobal(next);
  }

  const effectiveKeySources = (): Record<string, KeySource> => {
    const out: Record<string, KeySource> = {};
    for (const [k, v] of Object.entries(global().keySources ?? {})) out[k] = coerceSource(v);
    for (const [k, v] of Object.entries(workspace().keySources ?? {})) out[k] = coerceSource(v);
    return out;
  };

  const store: CodeConfigStore = {
    read: (scope) => rawOf(scope),
    themeAt: (scope) => rawOf(scope).theme ?? {},
    effectiveTheme: () => mergeEffectiveTheme(global().theme ?? {}, workspace().theme ?? {}),
    agentDefault: () => {
      const w = workspace().agent?.default;
      const g = global().agent?.default;
      const d = w ?? g;
      return typeof d === "string" && d.length > 0 ? d : undefined;
    },
    guardModeDefault: () => {
      const d = workspace().guard?.mode ?? global().guard?.mode;
      return d === "off" || d === "on" || d === "auto" ? d : undefined;
    },
    asciiEnabled: () => (workspace().ui?.ascii ?? global().ui?.ascii) === true,
    keyboardConfig: () => normalizeKeyboardConfig(global().ui?.keyboard),
    keySources: effectiveKeySources,
    keySource: (varName) => effectiveKeySources()[varName] ?? "auto",
    overrideSource: (mode, token) => {
      if (workspace().theme?.overrides?.[mode]?.[token]) return "workspace";
      if (global().theme?.overrides?.[mode]?.[token]) return "global";
      return null;
    },
    write: (scope, patch) => persist(scope, (cur) => ({ ...cur, ...patch })),
    writeAscii: (scope, on) =>
      persist(scope, (cur) => ({ ...cur, ui: { ...(cur.ui ?? {}), ascii: on } })),
    writeKeyboardEnvironment: (environmentId, config) => {
      if (!/^[a-f0-9]{24}$/.test(environmentId)) throw new Error("invalid keyboard environment id");
      persist("global", (cur) => {
        const environments = storedKeyboardEnvironments(cur.ui?.keyboard);
        if (config) environments[environmentId] = config;
        else delete environments[environmentId];
        return {
          ...cur,
          ui: {
            ...(cur.ui ?? {}),
            keyboard: { version: 1, environments },
          },
        };
      });
    },
    writeTheme: (scope, theme) => persist(scope, (cur) => ({ ...cur, theme })),
    writeAgentDefault: (scope, name) =>
      persist(scope, (cur) => ({ ...cur, agent: { ...(cur.agent ?? {}), default: name } })),
    clearAgentDefault: (scope) =>
      persist(scope, (cur) => {
        const agent = { ...(cur.agent ?? {}) };
        delete agent.default;
        const next = { ...cur };
        if (Object.keys(agent).length === 0) delete next.agent;
        else next.agent = agent;
        return next;
      }),
    writeKeySource: (scope, varName, source) =>
      persist(scope, (cur) => {
        const next = { ...(cur.keySources ?? {}) };
        if (source === "auto") delete next[varName];
        else next[varName] = source;
        const updated: CodeConfig = { ...cur, keySources: next };
        if (Object.keys(next).length === 0) delete updated.keySources;
        return updated;
      }),
    hasWorkspace: () => dirs.workspace != null,
  };
  return store;
}

export { mergeThemeBlock };
