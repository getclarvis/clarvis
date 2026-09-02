import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";
import { compareAgentDisplayOrder } from "@clarvis/kernel/config";
import type { ProfileInfo } from "./run-types.ts";
import type { CodeConfigStore } from "./code-config.ts";
import { deriveAgentShape, profileView, type AgentProfileView, type AgentShape } from "./agents.ts";

const UNKNOWN_SHAPE: AgentShape = {
  isLead: false,
  askUserGranted: "unknown",
  softMode: false,
};

/**
 * Reactive view of the currently selected agent profile, derived from the
 * merged Agent Profile list and the session/default fallback.
 */
export interface ActiveAgentStore {
  active: Accessor<string>;
  view: Accessor<AgentProfileView | undefined>;
  shape: Accessor<AgentShape>;
  list: Accessor<AgentProfileView[]>;
  resolveActive(): string;
  setActive(name: string): void;
  setDefault(name: string, scope: "global" | "workspace"): void;
  /**
   * Whether a profile can actually run under the current settings.
   *
   * @remarks Exposed so a surface that *offers* a profile can say so before the
   *   user picks it. The agent picker used to accept an unrunnable agent with
   *   no warning at all, and the problem surfaced only once a prompt had been
   *   sent and failed — invariant 2 read backwards: selectable but not usable.
   */
  isRunnable(name: string): boolean;
}

/** Inputs {@link createActiveAgentStore} needs to resolve and persist the active agent. */
export interface ActiveAgentDeps {
  profiles: Accessor<ProfileInfo[]>;
  code: Pick<CodeConfigStore, "agentDefault" | "writeAgentDefault">;
  sessionProfile: () => string | undefined;
  persistActive: (name: string) => void;
  /** Whether a profile is runnable under the current settings. Unknown/plugin profiles may return true. */
  isRunnable?: (name: string) => boolean;
}

/** The minimum profile shape the automatic entry-agent fallback needs. */
export interface AutomaticAgentCandidate {
  name: string;
  isLead: boolean;
}

const byName = <T extends { name: string }>(a: T, b: T): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * Pick a safe automatic entry agent without depending on filesystem order.
 *
 * @remarks `marshall` is the product's general-purpose entry profile and wins
 * by name alone — the Lead test below does not apply to it. The shipped
 * `marshall` is a Lead; one an overlay has stripped `can_spawn` from is still
 * the profile the operator named for this role, and demoting it would hand the
 * default to some other agent under a name the user never chose.
 *
 * The restriction binds only the fallback branch: with no `marshall`, just a
 * runnable Lead is eligible. Sub-agent personas are valid explicit choices, but
 * they must never become the default merely because their file happened to be
 * returned first by `readdirSync`. An all-headless fleet therefore yields `""`
 * rather than an arbitrary member.
 */
export function automaticAgentFallback(
  candidates: readonly AutomaticAgentCandidate[],
  isRunnable: (name: string) => boolean = () => true,
): string {
  const runnable = [...candidates].filter((p) => isRunnable(p.name)).sort(byName);
  return (
    runnable.find((p) => p.name === "marshall")?.name ?? runnable.find((p) => p.isLead)?.name ?? ""
  );
}

/**
 * Builds an {@link ActiveAgentStore} that keeps the active agent name valid as
 * the Agent Profile list changes, falling back through session profile then
 * configured default, runnable `marshall`, then the first runnable Lead.
 */
export function createActiveAgentStore(deps: ActiveAgentDeps): ActiveAgentStore {
  const list = createMemo<AgentProfileView[]>(() =>
    deps.profiles().map(profileView).sort(compareAgentDisplayOrder),
  );

  function resolveActive(): string {
    const names = new Set(list().map((v) => v.name));
    const session = deps.sessionProfile();
    if (session && names.has(session)) return session;
    const fallbackDefault = deps.code.agentDefault();
    const isRunnable = deps.isRunnable ?? (() => true);
    if (fallbackDefault && names.has(fallbackDefault) && isRunnable(fallbackDefault))
      return fallbackDefault;
    return automaticAgentFallback(
      list().map((profile) => ({ name: profile.name, isLead: deriveAgentShape(profile).isLead })),
      isRunnable,
    );
  }

  const [active, setActiveSignal] = createSignal("");

  createEffect(() => {
    const names = list().map((v) => v.name);
    const current = active();
    if (!current || !names.includes(current)) setActiveSignal(resolveActive());
  });

  const view = createMemo(() => list().find((v) => v.name === active()));
  const shape = createMemo(() => {
    const v = view();
    return v ? deriveAgentShape(v) : UNKNOWN_SHAPE;
  });

  function setActive(name: string): void {
    setActiveSignal(name);
    deps.persistActive(name);
  }
  function setDefault(name: string, scope: "global" | "workspace"): void {
    deps.code.writeAgentDefault(scope, name);
  }

  return {
    active,
    view,
    shape,
    list,
    resolveActive,
    setActive,
    setDefault,
    isRunnable: (name) => deps.isRunnable?.(name) ?? true,
  };
}
