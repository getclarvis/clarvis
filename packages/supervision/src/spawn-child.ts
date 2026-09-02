/**
 * The register-a-background-child skeleton shared by every producer that
 * spawns into the supervision registry: the loop's own `delegate_task`
 * handler and `@clarvis/workflows`' `run_leader` handler.
 *
 * @remarks Only the identical part is extracted here — build the control
 * plumbing, register, bail on `null`, record `agent_registered`. What each
 * producer does with the resulting task (semaphore, compute-clock region, the
 * actual run, its `settled()` mapping, and any producer-specific trace
 * events) differs enough that forcing it through a shared callback would be
 * more abstraction than the duplication it replaces.
 */
import type { TracePort } from "@clarvis/capability";
import { createSteerQueue, type SteerQueue } from "./steer-queue.ts";
import type { AgentHandle, AgentKind, AgentRegistryPort } from "@clarvis/capability";

/** What a producer must supply to register one background child. */
export interface BackgroundChildSpec {
  kind: AgentKind;
  /** The child's own id in its native space: a `subagent_instance_id` for a
   * sub-agent, a `run_id` for a leader. */
  nativeId: string;
  title: string;
  profile?: string;
}

/** The three handles a producer needs to run and later settle its child. */
export interface BackgroundChildSpawn {
  handle: AgentHandle;
  controller: AbortController;
  steerQueue: SteerQueue;
}

/** Producer-side accounting committed at the registry-acceptance boundary. */
export type BackgroundChildRegistered = (spawn: BackgroundChildSpawn) => void;

/**
 * Register a background child with the supervision registry.
 *
 * @param agents - the run's registry.
 * @param trace - the registering agent's trace, for the `agent_registered`
 *   record.
 * @param spec - what to register.
 * @param onRegistered - optional producer accounting invoked after registry
 *   acceptance and before trace publication. If it or the trace sink throws,
 *   the accepted child is aborted, settled and closed before the error escapes.
 * @returns the child's {@link AgentHandle} plus the fresh `AbortController`
 *   and {@link SteerQueue} wired into its `control`, or `null` when the
 *   registry declined (sealed or at its live-children ceiling) — a producer
 *   must treat `null` as "do not spawn" and answer with a plain refusal.
 */
export function registerBackgroundChild(
  agents: AgentRegistryPort,
  trace: TracePort,
  spec: BackgroundChildSpec,
  onRegistered?: BackgroundChildRegistered,
): BackgroundChildSpawn | null {
  const controller = new AbortController();
  const steerQueue = createSteerQueue();
  const handle = agents.register({
    kind: spec.kind,
    nativeId: spec.nativeId,
    title: spec.title,
    ...(spec.profile !== undefined ? { profile: spec.profile } : {}),
    control: {
      stop: (reason) => {
        controller.abort(new Error(reason));
      },
      steer: (message) => steerQueue.push(message),
      undrained: () => steerQueue.undrained().length,
    },
  });
  if (handle === null) return null;

  const spawn = { handle, controller, steerQueue };
  try {
    onRegistered?.(spawn);
    trace.record("agent_registered", {
      agent_id: handle.id,
      kind: spec.kind,
      native_id: spec.nativeId,
      title: spec.title,
      ...(spec.profile !== undefined ? { profile: spec.profile } : {}),
      background: true,
    });
  } catch (error) {
    try {
      controller.abort(error);
    } catch {}
    try {
      handle.settled({
        status: "failed",
        result: "background child registration failed before adoption",
      });
    } catch {}
    try {
      steerQueue.close();
    } catch {}
    throw error;
  }

  return spawn;
}
