import { createHash } from "node:crypto";
import type { HostCapability, HostMetadata, HostPlatform } from "@opentui/keymap";

/** Whether the active terminal path is known to deliver a keyboard capability. */
export type CapabilityState = "supported" | "unsupported" | "unknown";

/** Keyboard behavior selected for one terminal path. */
export type KeyboardProfile = "portable" | "enhanced" | "manual";

/** The client-side convention used to present modifier names. */
export type ClientPlatform = "macos" | "windows" | "linux";

/** Non-sensitive facts that determine which bindings may be advertised. */
export interface KeyboardEnvironment {
  transport: "local" | "ssh";
  runtimePlatform: HostPlatform;
  terminal: { name: string; version?: string };
  protocol: "kitty" | "legacy";
  multiplexer: "none" | "tmux" | "zellij" | "screen" | "unknown";
  modifiers: Record<"ctrl" | "shift" | "meta" | "super" | "hyper", CapabilityState>;
  baseLayout: CapabilityState;
  profile: KeyboardProfile;
  clientPlatform?: ClientPlatform;
}

/** Persisted UI-only preferences for one keyboard environment. */
export interface KeyboardEnvironmentConfig {
  profile: KeyboardProfile;
  clientPlatform?: ClientPlatform;
  verdicts?: Partial<
    Record<"ctrl" | "shift" | "meta" | "super" | "hyper" | "baseLayout", CapabilityState>
  >;
  bindings?: Record<string, string[]>;
}

/** Versioned keyboard block stored only in the global `code.json`. */
export interface KeyboardConfig {
  version: 1;
  environments: Record<string, KeyboardEnvironmentConfig>;
}

/** Inputs collected from OpenTUI without retaining raw input or host identity. */
export interface KeyboardEnvironmentInput {
  remote: boolean;
  runtimePlatform: HostPlatform;
  terminal?: { name?: string; version?: string };
  kittyKeyboard: boolean;
  multiplexer?: string;
  host: HostMetadata;
}

/** One possible binding for an action, resolved against the effective environment. */
export interface BindingCandidate {
  key: string;
  minimumProfile?: "portable" | "enhanced";
  requires?: readonly (keyof KeyboardEnvironment["modifiers"] | "baseLayout")[];
}

/** A validation problem that prevents a manual override from activating. */
export interface KeyboardBindingIssue {
  command: string;
  key?: string;
  message: string;
  /**
   * For a shadow or prefix conflict, the other command involved; absent on
   * every other kind.
   *
   * @remarks It is what lets a caller tell "this override shadows a vital
   *   action" from "a vital action has some unrelated problem", which are the
   *   same `command` and need opposite answers. See
   *   {@link applyManualBindingEdit}.
   */
  shadows?: string;
}

/** Vital actions may be rebound, but never explicitly unbound. */
const PROTECTED_ACTIONS = new Set(["app.escape", "run.cancel"]);

const PROTECTED_DEFAULT_BINDINGS: Readonly<Record<string, string>> = {
  "app.escape": "escape",
  "run.cancel": "ctrl+c",
};

const EMPTY_KEYBOARD_CONFIG: KeyboardConfig = { version: 1, environments: {} };

function capability(value: unknown): CapabilityState | undefined {
  return value === "supported" || value === "unsupported" || value === "unknown"
    ? value
    : undefined;
}

function clientPlatform(value: unknown): ClientPlatform | undefined {
  return value === "macos" || value === "windows" || value === "linux" ? value : undefined;
}

function profile(value: unknown): KeyboardProfile | undefined {
  return value === "portable" || value === "enhanced" || value === "manual" ? value : undefined;
}

/** Tolerantly reads the versioned keyboard block from an otherwise forward-compatible UI config. */
export function normalizeKeyboardConfig(value: unknown): KeyboardConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY_KEYBOARD_CONFIG;
  const raw = value as { version?: unknown; environments?: unknown };
  if (raw.version !== 1 || !raw.environments || typeof raw.environments !== "object")
    return EMPTY_KEYBOARD_CONFIG;

  const environments: Record<string, KeyboardEnvironmentConfig> = {};
  for (const [id, candidate] of Object.entries(raw.environments)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const selected = profile(item.profile);
    if (!selected) continue;
    const next: KeyboardEnvironmentConfig = { profile: selected };
    const client = clientPlatform(item.clientPlatform);
    if (client) next.clientPlatform = client;

    if (item.verdicts && typeof item.verdicts === "object" && !Array.isArray(item.verdicts)) {
      const verdicts: NonNullable<KeyboardEnvironmentConfig["verdicts"]> = {};
      for (const key of ["ctrl", "shift", "meta", "super", "hyper", "baseLayout"] as const) {
        const state = capability((item.verdicts as Record<string, unknown>)[key]);
        if (state) verdicts[key] = state;
      }
      if (Object.keys(verdicts).length > 0) next.verdicts = verdicts;
    }

    if (item.bindings && typeof item.bindings === "object" && !Array.isArray(item.bindings)) {
      const bindings: Record<string, string[]> = {};
      for (const [command, keys] of Object.entries(item.bindings)) {
        if (!Array.isArray(keys)) continue;
        bindings[command] = keys.filter(
          (key): key is string => typeof key === "string" && key.trim().length > 0,
        );
      }
      if (Object.keys(bindings).length > 0) next.bindings = bindings;
    }
    environments[id] = next;
  }
  return { version: 1, environments };
}

function normalizedMultiplexer(value: string | undefined): KeyboardEnvironment["multiplexer"] {
  return value === "none" || value === "tmux" || value === "zellij" || value === "screen"
    ? value
    : "unknown";
}

function normalizedHostCapability(value: HostCapability | undefined): CapabilityState {
  return value === "supported" || value === "unsupported" ? value : "unknown";
}

/** Conservative automatic profile: enhanced is automatic only for local Kitty input. */
export function defaultKeyboardProfile(input: KeyboardEnvironmentInput): KeyboardProfile {
  return !input.remote && input.kittyKeyboard ? "enhanced" : "portable";
}

/** Builds the effective environment, applying only explicit saved verdicts and profile choices. */
export function buildKeyboardEnvironment(
  input: KeyboardEnvironmentInput,
  saved?: KeyboardEnvironmentConfig,
): KeyboardEnvironment {
  const modifiers: KeyboardEnvironment["modifiers"] = {
    ctrl: normalizedHostCapability(input.host.modifiers.ctrl),
    shift: normalizedHostCapability(input.host.modifiers.shift),
    meta: normalizedHostCapability(input.host.modifiers.meta),
    super: normalizedHostCapability(input.host.modifiers.super),
    hyper: normalizedHostCapability(input.host.modifiers.hyper),
  };
  for (const key of Object.keys(modifiers) as (keyof typeof modifiers)[]) {
    const verdict = saved?.verdicts?.[key];
    if (verdict) modifiers[key] = verdict;
  }
  return {
    transport: input.remote ? "ssh" : "local",
    runtimePlatform: input.runtimePlatform,
    terminal: {
      name: input.terminal?.name?.trim() || "unknown",
      ...(input.terminal?.version?.trim() ? { version: input.terminal.version.trim() } : {}),
    },
    protocol: input.kittyKeyboard ? "kitty" : "legacy",
    multiplexer: normalizedMultiplexer(input.multiplexer),
    modifiers,
    baseLayout: saved?.verdicts?.baseLayout ?? (input.kittyKeyboard ? "supported" : "unknown"),
    profile: saved?.profile ?? defaultKeyboardProfile(input),
    ...(saved?.clientPlatform ? { clientPlatform: saved.clientPlatform } : {}),
  };
}

/**
 * Stable, opaque identifier for a compatibility path.
 *
 * @remarks It deliberately excludes hostname, IP address, username, raw key data
 *   and typed text.
 *
 *   It also excludes the terminal's **version**, even though
 *   {@link KeyboardEnvironment.terminal} carries it for display. A version is
 *   not a compatibility dimension — what decides which keys arrive is the
 *   terminal program, the protocol it negotiated, the multiplexer in the way and
 *   whether the session is remote. Hashing the version instead minted a fresh id
 *   on every emulator patch bump, which silently orphaned that path's saved
 *   profile, manual bindings and capability verdicts (the user's accelerators
 *   just stopped, with nothing to explain it) and left one unreachable
 *   `environments` record behind per version, forever.
 */
export function keyboardEnvironmentId(input: KeyboardEnvironmentInput): string {
  const dimensions = {
    transport: input.remote ? "ssh" : "local",
    runtimePlatform: input.runtimePlatform,
    terminal: (input.terminal?.name ?? "unknown").trim().toLowerCase(),
    protocol: input.kittyKeyboard ? "kitty" : "legacy",
    multiplexer: normalizedMultiplexer(input.multiplexer),
  };
  return createHash("sha256").update(JSON.stringify(dimensions)).digest("hex").slice(0, 24);
}

function requirementState(
  environment: KeyboardEnvironment,
  requirement: keyof KeyboardEnvironment["modifiers"] | "baseLayout",
): CapabilityState {
  return requirement === "baseLayout" ? environment.baseLayout : environment.modifiers[requirement];
}

function enhancedCandidateAllowed(
  candidate: BindingCandidate,
  environment: KeyboardEnvironment,
): boolean {
  if (environment.profile === "portable") return false;
  return (candidate.requires ?? []).every(
    (requirement) => requirementState(environment, requirement) === "supported",
  );
}

/** Resolves overrides first, then supported enhanced alternatives, then portable defaults. */
export function resolveCommandBindings(
  command: string,
  candidates: readonly BindingCandidate[],
  environment: KeyboardEnvironment,
  overrides: Readonly<Record<string, readonly string[]>> = {},
): string[] {
  const manual = overrides[command];
  if (manual && manual.length > 0) return [...new Set(manual.map((key) => key.trim()))];
  const enhanced = candidates
    .filter(
      (candidate) =>
        candidate.minimumProfile === "enhanced" && enhancedCandidateAllowed(candidate, environment),
    )
    .map((candidate) => candidate.key);
  const portable = candidates
    .filter((candidate) => candidate.minimumProfile !== "enhanced")
    .map((candidate) => candidate.key);
  return [...new Set([...enhanced, ...portable])];
}

function looksLikeKeySequence(value: string): boolean {
  const strokes = value.trim().split(/\s+/);
  if (strokes.length === 0) return false;
  return strokes.every((stroke) => {
    const parts = stroke.split("+");
    if (parts.some((part) => part.trim().length === 0)) return false;
    const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase());
    return modifiers.every((part) =>
      ["ctrl", "control", "shift", "alt", "meta", "option", "cmd", "super", "hyper"].includes(part),
    );
  });
}

/**
 * Validates overrides before any of them are activated.
 *
 * @param bindings - the environment's complete override map.
 * @param commands - the commands currently registered on the keymap.
 * @param normalizeKey - canonical form of one key sequence, for the
 *   shadowing comparison; defaults to trim + lower-case.
 * @param defaultBindings - every binding resolved from the active profile;
 *   a command with a manual override has its default omitted.
 * @returns every issue found, across the whole map.
 * @remarks `normalizeKey` is what makes the shadowing rule mean anything. The
 *   comparison used to be between raw lower-cased strings, so `esc` and
 *   `escape` — the same key to the keymap that ultimately binds them — read as
 *   two different keys, and an ordinary command could quietly take a reserved
 *   vital action's binding by spelling it the other way. The caller supplies the
 *   keymap's own parser, so "the same key" means the same thing here as it does
 *   at dispatch.
 */
/**
 * Spellings of the same key that the fallback normalizer must not treat as
 * different keys.
 *
 * @remarks The shadowing rule compares normalized strings, so an alias is a way
 * to take a protected action's key by writing it another way — the precise hole
 * the `normalizeKey` parameter exists to close. Its default was
 * `trim().toLowerCase()`, under which `escape` was correctly refused for
 * `app.quit` while `esc` was accepted, and the key then fired for the command
 * that was never supposed to have it. A caller with a real keymap should still
 * inject its own canonical form; this only stops the fallback from being a
 * bypass.
 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "escape",
  ret: "return",
  enter: "return",
  del: "delete",
  ins: "insert",
  pgup: "pageup",
  pgdn: "pagedown",
  pgdown: "pagedown",
  spc: "space",
  ctl: "ctrl",
  control: "ctrl",
  opt: "alt",
  option: "alt",
  cmd: "meta",
  super: "meta",
  win: "meta",
};

/** Applies {@link KEY_ALIASES} to each part of a `+`/space-separated sequence. */
function canonicalizeAliases(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((chord) =>
      chord
        .split("+")
        .map((part) => KEY_ALIASES[part] ?? part)
        .join("+"),
    )
    .join(" ");
}

export function validateManualBindings(
  bindings: Readonly<Record<string, readonly string[]>>,
  commands: ReadonlySet<string>,
  normalizeKey: (key: string) => string = canonicalizeAliases,
  defaultBindings: Readonly<
    Record<string, string | readonly string[]>
  > = PROTECTED_DEFAULT_BINDINGS,
): KeyboardBindingIssue[] {
  const issues: KeyboardBindingIssue[] = [];
  const owners = new Map<string, string>();
  const ownedSequences: { command: string; strokes: readonly string[] }[] = [];
  const canonical = (key: string): string => {
    try {
      return normalizeKey(key);
    } catch {
      return canonicalizeAliases(key);
    }
  };
  const remember = (command: string, normalized: string): void => {
    owners.set(normalized, command);
    ownedSequences.push({ command, strokes: normalized.trim().split(/\s+/) });
  };
  const strictPrefix = (left: readonly string[], right: readonly string[]): boolean =>
    left.length < right.length && left.every((stroke, index) => stroke === right[index]);
  for (const [command, value] of Object.entries(defaultBindings)) {
    if (command in bindings) continue;
    for (const key of typeof value === "string" ? [value] : value) {
      remember(command, canonical(key));
    }
  }
  for (const [command, keys] of Object.entries(bindings)) {
    if (!commands.has(command)) {
      issues.push({ command, message: "unknown command" });
      continue;
    }
    if (keys.length === 0) {
      issues.push({
        command,
        message: PROTECTED_ACTIONS.has(command)
          ? "protected action cannot be unbound"
          : "an override must contain at least one binding",
      });
      continue;
    }
    for (const raw of keys) {
      const key = raw.trim().toLowerCase();
      if (!looksLikeKeySequence(key)) {
        issues.push({ command, key: raw, message: "invalid key sequence" });
        continue;
      }
      const normalized = canonical(key);
      const owner = owners.get(normalized);
      if (owner && owner !== command) {
        issues.push({ command, key: raw, message: `binding shadows ${owner}`, shadows: owner });
        continue;
      }
      const strokes = normalized.trim().split(/\s+/);
      const prefixConflict = ownedSequences.find(
        (candidate) =>
          (PROTECTED_ACTIONS.has(command) || PROTECTED_ACTIONS.has(candidate.command)) &&
          (strictPrefix(candidate.strokes, strokes) || strictPrefix(strokes, candidate.strokes)),
      );
      if (prefixConflict !== undefined) {
        issues.push({
          command,
          key: raw,
          message: `binding has an ambiguous prefix with ${prefixConflict.command}`,
          shadows: prefixConflict.command,
        });
        continue;
      }
      remember(command, normalized);
    }
  }
  return issues;
}

/**
 * Folds one manual-binding edit into an environment's stored record.
 *
 * @param opts.saved - the environment's record as stored, or absent.
 * @param opts.command - the command whose override is being edited.
 * @param opts.keys - its new key sequences; empty clears the override.
 * @param opts.knownCommands - commands currently registered on the keymap.
 * @param opts.invalidKeys - keys the keymap refused to parse, reported as-is.
 * @param opts.defaultBindings - every binding resolved from the active profile
 *   before manual overrides are applied.
 * @returns the record to write, or the issues that block the write.
 * @remarks Two rules live here rather than at the call site, because both are
 *   the kind of mistake that reads as correct.
 *
 *   The whole map is validated — so a new key can be seen shadowing a sibling
 *   override — but only conflicts touching the **edited** command or a vital
 *   action block the write. A stale entry naming a command that is no
 *   longer registered (an MCP prompt whose server was removed from
 *   `settings.json`) reports "unknown command" forever, and reporting it here
 *   made every later edit impossible, including clearing that very entry.
 *
 *   Inspecting both `command` and `shadows` closes the other half. A conflict is
 *   reported against whichever command is *seen second*, so filtering only that
 *   field made the result depend on persisted object order. Only `shadows`
 *   issues involving a vital action are admitted, not every issue it can carry: a
 *   hand-edited `keyboard.json` that leaves one unbound, or names one no longer
 *   registered, would otherwise block every later edit with a message about a
 *   command the user is not editing — the very trap the paragraph above says
 *   was closed.
 *
 *   And `bindings` is set or deleted explicitly. Spreading `saved` and re-adding
 *   `bindings` only when non-empty cannot express "no overrides at all": clearing
 *   the last one wrote the old map straight back, so the toast said the binding
 *   was gone while the key kept firing.
 */
export function applyManualBindingEdit(opts: {
  saved: KeyboardEnvironmentConfig | undefined;
  command: string;
  keys: readonly string[];
  knownCommands: ReadonlySet<string>;
  invalidKeys?: readonly string[];
  /** Canonical form of a key sequence; see {@link validateManualBindings}. */
  normalizeKey?: (key: string) => string;
  /** Effective profile defaults; overridden commands are excluded during validation. */
  defaultBindings?: Readonly<Record<string, string | readonly string[]>>;
}):
  | { config: KeyboardEnvironmentConfig; issues?: undefined }
  | { config?: undefined; issues: KeyboardBindingIssue[] } {
  const bindings = { ...(opts.saved?.bindings ?? {}) };
  if (opts.keys.length > 0) bindings[opts.command] = [...opts.keys];
  else delete bindings[opts.command];

  const issues = validateManualBindings(
    bindings,
    opts.knownCommands,
    opts.normalizeKey,
    opts.defaultBindings,
  ).filter(
    (issue) =>
      issue.command === opts.command ||
      issue.shadows === opts.command ||
      (issue.shadows !== undefined &&
        (PROTECTED_ACTIONS.has(issue.command) || PROTECTED_ACTIONS.has(issue.shadows))),
  );
  for (const key of opts.invalidKeys ?? []) {
    issues.push({ command: opts.command, key, message: "invalid key sequence" });
  }
  if (issues.length > 0) return { issues };

  const config: KeyboardEnvironmentConfig = { ...(opts.saved ?? {}), profile: "manual" };
  if (Object.keys(bindings).length > 0) config.bindings = bindings;
  else delete config.bindings;
  return { config };
}

/** Human-readable client convention without guessing from a remote runtime. */
export function effectiveClientPlatform(
  environment: KeyboardEnvironment,
): ClientPlatform | undefined {
  if (environment.clientPlatform) return environment.clientPlatform;
  if (environment.transport === "ssh") return undefined;
  return environment.runtimePlatform === "unknown" ? undefined : environment.runtimePlatform;
}
