/**
 * The public seam of the agent-supervision registry: the types a *producer* of
 * children (the loop's delegation capability, `@clarvis/workflows`' manager)
 * needs in order to register what it spawned, and nothing more.
 *
 * @remarks Kept free of implementation imports on purpose. `@clarvis/workflows`
 * reaches the registry through a typed `CapabilityServices` port, so these
 * types cross a package boundary while the registry itself does not.
 */
import type { SteerMessage } from "./api.ts";
import type { TraceEvent } from "./trace-events.ts";

/** What kind of child a handle addresses: a sub-agent of this run, or a leader
 * run spawned by a workflow manager. */
export type AgentKind = "subagent" | "leader";

/**
 * A child's lifecycle state as a parent sees it.
 *
 * @remarks `waiting` is still live — the child is parked on a question and is
 * distinguished from `running` precisely so a parent can tell a stalled child
 * from a working one. The four terminal states differ by *who* ended it:
 * `completed`/`failed` are the child's own outcome, `stopped` is an
 * `agent_stop` from its parent, and `cancelled` is the run going down.
 */
export type AgentStatus = "running" | "waiting" | "completed" | "failed" | "stopped" | "cancelled";

/** The terminal subset of {@link AgentStatus}. */
export type SettledStatus = Exclude<AgentStatus, "running" | "waiting">;

/** What a live child can be waiting on, or `null` when it is not waiting. */
export type WaitingOn = "elicitation" | null;

/**
 * The two control ports a producer supplies at registration, addressed to *one*
 * child: cancel it, and steer it.
 *
 * @remarks `stop` drives a per-child `AbortController` combined with the run's
 * own signal, so stopping one child never touches its siblings. `steer` pushes
 * onto that child's own steer queue and returns `false` once the child has
 * settled — a steer to a finished child is a plain refusal, never an error.
 */
export interface AgentControl {
  stop(reason: string): void;
  steer(message: SteerMessage): boolean;
  /** How many steers were queued for this child and never drained. Reported at
   * teardown so a steer that never reached its child is not lost in silence. */
  undrained?(): number;
}

/** What a producer declares about a child when it registers it. */
export interface AgentRegistration {
  kind: AgentKind;
  /** The child's own id in its native space: a `subagent_instance_id` for a
   * sub-agent, a `run_id` for a leader. Kept visible in the status so a
   * complaint can still be correlated against a trace. */
  nativeId: string;
  title: string;
  profile?: string;
  control: AgentControl;
}

/** A child's terminal outcome, reported once by its producer. */
export interface AgentSettlement {
  status: SettledStatus;
  /** The child's result text, or the error message when it failed. */
  result?: string;
  iterations?: number;
  tokens?: number;
}

/**
 * A producer's handle on one registered child: where it reports activity and
 * the child's eventual outcome.
 *
 * @remarks A sub-agent's activity is routed to it by the registry off the run's
 * own trace (its entries already carry `subagent_instance_id`), so a sub-agent
 * producer never calls `ingest`. A leader runs its own `executeRun` with its own
 * trace, so its producer forwards that stream here.
 */
export interface AgentHandle {
  readonly id: string;
  /** Feed one event from a leader's forwarded trace into this child's buffer. */
  ingest(event: TraceEvent): void;
  /** Mark the child parked on a question, or no longer parked. */
  waiting(on: WaitingOn): void;
  /** Record the terminal outcome. Idempotent: the first settle wins. */
  settled(settlement: AgentSettlement): void;
}

/**
 * The slice of the registry a producer may use.
 *
 * @remarks Deliberately write-only: reading the tree is the supervision tools'
 * job, not a producer's.
 */
export interface AgentRegistryPort {
  /**
   * Register a child about to be spawned.
   *
   * @returns its handle, or `null` when the registry is sealed (the run is
   *   finishing) or already at its live-children ceiling. A producer must treat
   *   `null` as "do not spawn" and answer the model with a plain refusal.
   */
  register(registration: AgentRegistration): AgentHandle | null;
  /**
   * Hand the registry the in-flight promise of a background child, so teardown
   * can wait on it rather than abandoning its token usage.
   *
   * @remarks The registry attaches its own rejection handler; the producer must
   * not also await the task, or the spawn stops being background.
   */
  adopt(id: string, task: Promise<unknown>): void;
  /** How many children are neither settled nor evicted. */
  liveCount(): number;
}
