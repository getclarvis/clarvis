/**
 * The capability contract: a cross-cutting feature (memory, skills, guard-carrying
 * agent tools, …) packages everything it adds to a run behind one interface, and
 * the engine composes a list instead of knowing each feature by name.
 *
 * Three lifecycle levels, narrowing at each step:
 *
 *   Capability            process-lifetime (or per-run for session-bound hosts)
 *     └─ forRun(ctx)  →   RunCapability | null      per-run gate + activation
 *          └─ forAgent(scope) → AgentCapability | null   per-agent (grants) gate
 *               └─ attach(bc) → AgentLoopContribution    loop-time contribution
 */
import type { EnvConfig } from "./env.ts";
import type { LLMProvider, ToolChoice } from "./llm-port.ts";
import type { Logger } from "./ports.ts";
import type { LifecycleHook, RunRequest } from "./api.ts";
import type { NamespacedTool } from "./run.ts";
import type { ExecutionRecord } from "./trace-events.ts";
import type { ExecutionStatus } from "./execution-status.ts";
import type { CompactionAnchor } from "./compaction-anchor.ts";
import type {
  AgentBuildContext,
  FinalizeGate,
  OrchestrationHooks,
  ToolHandler,
} from "./loop-contract.ts";
import type { ComputeClock } from "./compute-clock.ts";
import type { Elicit } from "./elicit.ts";
import type { CapabilityServices } from "./services.ts";
import type { ToolEffect } from "./tool-effect.ts";
import type { PersistedTraceProjector } from "./trace-projectors.ts";
import type { OutputTokenBudget } from "./output-budget.ts";

/** Re-exported so capability authors can depend on this module alone. */
export type { AgentBuildContext };

/** Host-facing progress/notice channel; generalizes memory's ingest notices. */
export interface CapabilityEvent {
  capability: string;
  kind: string;
  detail?: unknown;
  /**
   * The client-facing projection of this event, declared by whoever emits it.
   *
   * @remarks A host maps an event to its wire protocol only when this is
   * present, and drops it otherwise. The projection travels *on the event*
   * rather than through a registry the host consults because the host's mapper
   * is a pure function of one event — and because the alternative, an allowlist
   * of capability names, silently discards every event from a capability the
   * host was not written to know about. The emitter owns the projection; the
   * host remains free to validate or reshape it before it reaches a client.
   */
  wire?: { type: string; detail?: Record<string, unknown> };
}

/** Receives a {@link CapabilityEvent}; the engine swallows listener throws. */
export type CapabilityEventListener = (event: CapabilityEvent) => void;

/**
 * The request surface available to capability preflight and activation.
 *
 * @remarks One view is constructed after request validation and passed to both
 * {@link Capability.requiresUserInput} and {@link Capability.forRun}. Keeping
 * the accessor beside the parsed request means a capability never has to cast
 * the open request object to read a parameter declared by its settings spec.
 */
export interface CapabilityRequestView {
  /** The parsed + validated request. */
  readonly request: RunRequest;
  /** Read one capability-owned per-run request parameter. */
  readonly requestParam: (key: string) => unknown;
}

/** A grant contributed to the request vocabulary by one capability. */
export interface CapabilityGrantDeclaration {
  /** The exact grant name profiles may carry. */
  readonly name: string;
  /** Whether this grant lets a non-lead entry agent produce supervised children. */
  readonly entryCanSpawn?: boolean;
}

/** The per-run context passed to {@link Capability.forRun}: the request, the
 * caller's identity/grants, the resolved environment and workspace, the model,
 * and the host channels (elicit, logger, event emit, abort signal). */
export interface RunCapabilityContext extends CapabilityRequestView {
  readonly owner: string;
  readonly entryGrants: readonly string[];
  readonly env: EnvConfig;
  readonly workspaceRoot: string;
  readonly llm: LLMProvider;
  /** The host's raw elicit channel, when the MCP client supports elicitation. */
  readonly elicit?: Elicit;
  readonly logger?: Logger;
  /** Emit a host-visible event. Listener throws are swallowed by the engine. */
  readonly emit: CapabilityEventListener;
  /** The run's abort signal; long work in forRun/seedBlock should observe it. */
  readonly signal?: AbortSignal;
  /**
   * The `capability_state` the prior run left behind, when this run continues one.
   *
   * @remarks Keyed by capability name; a capability reads back only its own slot,
   * and the value is exactly what its own {@link RunCapability.finalizeRun}
   * returned. Absent for a fresh run, and absent for a capability that wrote
   * nothing.
   */
  readonly priorState?: Record<string, unknown>;
  /**
   * The run's inter-capability port registry.
   *
   * @remarks The engine publishes run substrate before any `forRun` executes;
   * capabilities publish their own ports in `forRun` and consumers read at
   * `attach` time. See {@link CapabilityServices} for why capability-to-
   * capability reads must be the late ones.
   */
  readonly services: CapabilityServices;
  /**
   * The run's resolved execution id — the same id its trace is persisted under.
   *
   * @remarks A capability with durable state of its own needs the run's identity
   * to stamp it. The engine resolves this id (from the request, or minted) and
   * used to keep it to itself, so a capability outside the engine could not name
   * the run it was running in.
   */
  readonly executionId: string;
}

/**
 * The top-level, process-lifetime (or per-run, for session-bound hosts)
 * registration point for a cross-cutting feature: gates and activates itself
 * for one run via {@link forRun}.
 */
export interface Capability {
  readonly name: string;
  /** Static persisted projections this capability owns, collected before activation. */
  readonly persistedTraceProjectors?: readonly PersistedTraceProjector[];
  /** Grants this capability adds to the request vocabulary before validation. */
  readonly grants?: readonly CapabilityGrantDeclaration[];
  /**
   * Static open-tag of this capability's pinned seed block, if it emits one.
   * Collected from every REGISTERED capability (active or not) so a stale
   * block in a continuation is stripped even when the capability is gated off
   * on the current run.
   */
  readonly seedMarker?: string;
  /**
   * Wire names no MCP tool may take, because this capability owns them.
   *
   * @remarks Collected from every REGISTERED capability, active or not — the
   * same rule {@link seedMarker} follows — so a server cannot claim a name a
   * gated-off feature would have used and shadow it on the next run. Without
   * this the engine had to spell every capability's tool names in its own
   * reserved list, which is a list nothing can keep complete.
   */
  readonly reservedWireNames?: readonly string[];
  /**
   * What each of this capability's own tools *does* to the workspace, keyed by
   * wire name.
   *
   * @remarks Deliberately separate from {@link Capability.reservedWireNames},
   * which answers a different question: reservation is about who owns a *name*,
   * classification is about what invoking it *costs*. Folding one into the other
   * — classifying every reserved name as `control` — makes any capability tool
   * exempt from a gate that refuses "anything that could change the workspace"
   * purely by virtue of being reserved, and the exemption is silent. A reserved
   * name absent from this map therefore classifies as `unknown`, which is
   * refused rather than waved through.
   *
   * The engine's own vocabulary always wins: a capability classifies the tools
   * it contributes, never the engine's.
   */
  readonly toolEffects?: Readonly<Record<string, ToolEffect>>;
  /**
   * Whether this capability will need to reach a human for this request.
   *
   * @param view - the parsed request and capability-parameter accessor.
   * @returns `true` when the run must have an elicitation channel.
   * @remarks Consulted BEFORE any `forRun`, because a run that needs a human and
   * has no channel must be rejected as a validation error rather than hang
   * mid-flight. That ordering is why this sits on {@link Capability} rather than
   * on {@link RunCapability}.
   */
  requiresUserInput?(view: CapabilityRequestView): boolean;
  /**
   * Per-run gate + activation. Return null when the run does not use it.
   *
   * @remarks The engine awaits activations concurrently under
   * {@link EnvConfig.CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS}; a capability that
   * exceeds that wall budget is skipped for this run. Long work must observe
   * {@link RunCapabilityContext.signal} because timing out stops waiting but
   * cannot forcibly stop arbitrary host code.
   */
  forRun(ctx: RunCapabilityContext): Promise<RunCapability | null> | RunCapability | null;
}

/** Agent identity known before the run clock exists (entry-seed time): whether
 * this is the lead or a subagent, whether it is the run's entry agent, and its
 * granted capability names. */
export interface AgentIdentity {
  readonly agent: "lead" | "subagent";
  /** True for the run's entry agent (lead or subagent-only), false for spawned. */
  readonly entry: boolean;
  readonly grants: readonly string[];
}

/** An {@link AgentIdentity} extended with the run-time channels available once
 * the agent loop exists: the compute clock, abort signal, and elicit. */
export interface AgentScope extends AgentIdentity {
  readonly clock?: ComputeClock;
  readonly signal?: AbortSignal;
  /** The run's serialized/relayed elicit, when user input is enabled. */
  readonly elicit?: Elicit;
}

/**
 * One {@link Capability}'s activation for a single run: its optional seed
 * block and system-prompt section, its lifecycle hooks, its per-agent gate
 * ({@link forAgent}), and its optional run-end hook.
 */
export interface RunCapability {
  readonly name: string;
  /**
   * Where this capability's contributions sit in the run's fold order; lower
   * runs first, registration order breaks ties. Defaults to `0`.
   *
   * @remarks Handler dispatch is first-match, so order is behaviour, not
   * cosmetics: planning's review blocker has to be consulted before the coding
   * toolset and before the MCP catch-all or it guards nothing. That used to be
   * arranged by array position at one call site, where nothing recorded that it
   * mattered.
   */
  readonly order?: number;
  /**
   * Pinned, non-evictable entry-context block (injected as a user-role entry,
   * never into the system prompt — the system head stays byte-stable across
   * runs to preserve provider prompt caching). Degrade internally: a throw
   * here fails the run. The engine stops waiting after
   * {@link EnvConfig.CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS} and omits the block.
   */
  seedBlock?(): Promise<string | undefined> | string | undefined;
  /**
   * Section this capability appends to an agent's system prompt (after the
   * base prompt), e.g. the skills catalog. Called at seed/spawn time — before
   * the run clock exists — hence the identity-only argument. Must agree with
   * `forAgent` for the same identity: resolve shared state once and serve
   * both from it.
   */
  systemSection?(id: AgentIdentity): string | undefined;
  /** Lifecycle hooks (gates + observers), collected into the run's hook chain
   * in capability registration order. */
  readonly lifecycle?: readonly LifecycleHook[];
  /** Per-agent gate; null = this agent does not get the capability. */
  forAgent(scope: AgentScope): AgentCapability | null;
  /**
   * Fires after the record persists.
   *
   * @remarks May return a promise, which the engine awaits under a bounded
   * budget ({@link EnvConfig.CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS}) so a
   * capability can make its *intent* durable before the response returns.
   * Resolve as soon as that durable part is done and continue the rest
   * detached — long work such as an inference call must never be awaited here.
   * Must not throw; a rejection or a timeout is logged and the run is
   * unaffected.
   */
  onRunEnd?(record: ExecutionRecord): void | Promise<void>;
  /**
   * Make this capability's durable state final, *before* the run's record is
   * built.
   *
   * @param outcome - the run's terminal status.
   * @returns the value to file under this capability's name in
   *   {@link ExecutionRecord.capability_state}, or `undefined` to write nothing.
   *   A returned promise is awaited, so the record is never built against
   *   half-finished state.
   * @remarks Distinct from {@link onRunEnd}, which fires *after* the record has
   * persisted and therefore cannot contribute to it. That ordering is the whole
   * reason this hook exists: sealing a plan and naming it on the record has to
   * happen before the write, while deleting a discarded plan has to happen after
   * it. A throw is logged and the slot is omitted; the run is unaffected. A
   * returned promise is bounded by
   * {@link EnvConfig.CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS}; a timeout likewise
   * forfeits only this turn's replacement value.
   */
  finalizeRun?(outcome: { status: ExecutionStatus }): unknown;
  /**
   * Error codes this capability terminates a run with that should read as a
   * guard trip rather than a plain fault.
   *
   * @remarks Only affects the `reason` on the run's `run_ended` entry. The engine
   * classifies its own codes; it cannot classify a code it does not declare, and
   * once {@link import("./run.ts").ErrorCode} opened, a capability's gate
   * terminations would otherwise all have been recorded as generic errors.
   */
  readonly guardTripCodes?: readonly string[];
}

/**
 * One {@link RunCapability}'s gate result for a single agent: present only
 * when that agent (per its {@link AgentScope}) gets the capability.
 */
export interface AgentCapability {
  /** Loop-time attachment; called once per agent loop (entry or spawned), so
   * per-agent state (e.g. call budgets) lives in the returned contribution. */
  attach(bc: AgentBuildContext): AgentLoopContribution;
}

/** What one capability adds to one agent loop. Generalizes `Orchestration`. */
export interface AgentLoopContribution {
  tools?: NamespacedTool[];
  handlers?: ToolHandler[];
  gates?: FinalizeGate[];
  /** At most one contribution per agent may provide an anchor. */
  anchor?: () => CompactionAnchor | undefined;
  /** At most one contribution per agent may provide a forced choice. */
  forcedChoice?: () => ToolChoice | undefined;
  hooks?: OrchestrationHooks;
  /**
   * Hard output-token ceiling shared with every agent that receives this
   * contribution. At most one contribution per agent may provide it.
   */
  outputBudget?: OutputTokenBudget;
  /**
   * Include this contribution's tools in availableWireNames (registry-style
   * visibility, like agent tools and memory). false for prompt-driven tools
   * (ask_user, load_skill, plan tools). Default true.
   */
  advertised?: boolean;
}

/** Everything a run's capabilities give one agent: the loop attachments plus
 * the system-prompt sections (both in capability registration order). */
export interface AgentActivation {
  capabilities: AgentCapability[];
  systemSections: string[];
}

/** Grant-gated per-subagent factory threaded into the spawn path. */
export type SubagentCapabilitiesFactory = (
  grants: readonly string[] | undefined,
) => AgentActivation;

/**
 * Declare a capability event's client-facing projection, mapping its `kind` to
 * the wire event `type` and carrying its `detail` through unchanged.
 *
 * @param event - the capability event to project.
 * @returns the same event with {@link CapabilityEvent.wire} filled in.
 * @remarks A host projects an event only when it carries a `wire`, and drops it
 *   otherwise. That is deliberate: the alternative — a host matching on known
 *   capability names — silently discards everything from a capability the host
 *   was not written to know about, which is precisely the coupling this contract
 *   exists to remove. Wrapping the emit is how a capability says "this one is
 *   for the client"; an event left unwrapped stays internal.
 */
export function projected(event: CapabilityEvent): CapabilityEvent {
  return {
    ...event,
    wire: {
      type: event.kind,
      ...(event.detail === undefined ? {} : { detail: event.detail as Record<string, unknown> }),
    },
  };
}
