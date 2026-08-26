import { createSignal, type Accessor } from "solid-js";
import { defaultGuardMode, type GuardConfig } from "@clarvis/kernel/policy";
import type { CodeConfigStore } from "./code-config.ts";
import type { SettingsAdapter } from "./settings.ts";

/** The command-guard policy for a run: never ask, always ask, or judge automatically. */
export type GuardMode = "off" | "on" | "auto";
const GUARD_MODES: readonly GuardMode[] = ["off", "on", "auto"];

/** Resolve the effective guard mode without exposing Kernel policy to presentation. */
export function resolvedGuardMode(guard: GuardConfig | undefined): GuardMode {
  return defaultGuardMode(guard);
}

/**
 * Whether guard mode "auto" can actually judge a command right now: it needs
 * a `default_model` that resolves to a configured provider.
 *
 * @remarks
 * Without a usable judge model, "auto" behaves as "on" at runtime (every ask
 * verdict just prompts the user) — this is the single check every surface
 * that offers "auto" (Run Controls, the Alt+G cycle) must agree on, so a
 * future change to the resolvability rule only needs to land once.
 */
export function guardAutoResolves(
  settings: Pick<SettingsAdapter, "effective" | "validateProviders">,
): boolean {
  const eff = settings.effective();
  return !!eff.default_model && settings.validateProviders(eff).ok;
}

/** The session's current {@link GuardMode}, settable directly or by cycling. */
export interface GuardModeStore {
  mode: Accessor<GuardMode>;
  setMode(mode: GuardMode): void;
  cycle(): GuardMode;
}

/** Inputs {@link createGuardModeStore} needs to seed and persist the guard mode. */
export interface GuardModeDeps {
  code: Pick<CodeConfigStore, "guardModeDefault">;
  settingsGuard: () => GuardConfig | undefined;
}

/**
 * Builds a {@link GuardModeStore}, seeded from `code`'s configured default
 * or, absent one, the workspace settings' {@link resolvedGuardMode}.
 */
export function createGuardModeStore(deps: GuardModeDeps): GuardModeStore {
  const initial = (): GuardMode =>
    deps.code.guardModeDefault() ?? resolvedGuardMode(deps.settingsGuard());
  const [mode, setMode] = createSignal<GuardMode>(initial());
  return {
    mode,
    setMode,
    cycle: () => {
      const next = GUARD_MODES[(GUARD_MODES.indexOf(mode()) + 1) % GUARD_MODES.length]!;
      setMode(next);
      return next;
    },
  };
}
