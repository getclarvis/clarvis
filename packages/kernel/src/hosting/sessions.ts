import type { ModelCost, RunDetail, RunResult, Session, StartRunParams } from "@clarvis/protocol";
import type { HostedRegistryOptions, PreparedHostedTurn } from "./registry.ts";
import { kernelError } from "../core/errors.ts";
import type { FileSessionService, HostSessionStore } from "../sessions/session-service.ts";
import { addRunUsage } from "../sessions/usage.ts";
import { buildSkillRunDigest, buildRecoveredContext } from "../runs/recovered-context.ts";
import { pauseGoalForPolicy } from "@clarvis/goal";
import { recoverGoalSettlementSession } from "../goals/settlement.ts";
import { goalStateFromSession, goalStateToDto } from "../goals/session-state.ts";
import { createHash, randomUUID } from "node:crypto";
import type { HostedConversationAuthority } from "./admission.ts";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";

/** An immutable execution binding prepared without starting inference or consuming a run stream. */
export interface HostedExecutionBinding extends Omit<
  PreparedHostedTurn,
  "title" | "reconcile" | "commitIntent"
> {
  /** Apply host-owned capability intent in the same short transaction as the new turn. */
  commitSessionIntent?(session: Session): void;
  /**
   * Validate terminal evidence outside the session lock, after physical closure. The returned
   * synchronous decision must revalidate its revision fences before changing state or charging usage.
   */
  prepareSettlement?(result: RunResult): Promise<(session: Session) => boolean>;
}

/** Host-assigned conversation and continuation provenance, never taken from model arguments. */
export interface HostedPreparationContext {
  session: Session;
  signal: AbortSignal;
  continuationOf?: string;
  conversation?: HostedConversationAuthority;
}

/** Canonical conversation stores and immutable run preparation supplied by the owning file host. */
export interface HostedSessionOptions {
  sessions: HostSessionStore;
  workspaceId: string;
  projectId: string;
  occupied(sessionId: string): boolean;
  prepareExecution(
    params: StartRunParams,
    context: HostedPreparationContext,
  ): Promise<HostedExecutionBinding>;
  redact(text: string): string;
  priceFor?(model: string): ModelCost | undefined;
  /**
   * Canonical result/trace for skill digests and steering-consumption reconciliation.
   * Missing, live or salvaged history cannot prove a steering message was not consumed.
   */
  readRun?(executionId: string): Promise<RunDetail | null>;
  /**
   * Settle a bound objective in the same durable write as its turn. Invoked only after the host's
   * physical closure barrier, including replay for late usage. True means it owns usage charging;
   * false leaves ordinary session accounting unchanged. The callback is synchronous and host-only.
   */
  settleSession?(session: Session, result: RunResult): boolean;
  now?: () => number;
  logger?: Logger;
  /** Best-effort display invalidation after canonical publication, never part of mutation authority. */
  goalChanged?(sessionId: string): void;
}

function revision(session: Session | null): number {
  const value = session?.revision ?? 0;
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER)
    throw kernelError("invalid_request", "invalid or exhausted hosted conversation revision");
  return value;
}

/** Compare preparation inputs independently of newly accepted, still pending operator messages. */
function preparationIdentity(session: Session | null): string {
  if (session === null) return "null";
  const {
    operator_intents: _intents,
    operator_sequence: _sequence,
    revision: _revision,
    updated_at: _updated,
    ...identity
  } = session;
  return JSON.stringify(identity);
}

/** Compare execution policy without conflating message content or reserved identity. */
function operatorPolicy(params: StartRunParams): string {
  const {
    messages: _messages,
    execution_id: _execution,
    continue_from: _previous,
    ...policy
  } = params;
  return JSON.stringify(policy);
}

/** Synchronous host mutation, committed with the canonical conversation under one short lock. */
export interface HostedSessionTransactions {
  transact<T>(
    sessionId: string,
    mutation: (session: Session) => { session: Session; result: T },
  ): Promise<T>;
}

/**
 * Own hosted turn intent and settlement on the existing session document. Interactive saves may
 * edit metadata/pending observations between activities or under their own local activity lease,
 * and only at the observed revision. Execution history and totals remain exclusively host-owned.
 * Locks reserve before the first await and never retain an unbounded queue of stale UI documents.
 */
export function createHostedSessionCoordinator(
  options: HostedSessionOptions,
): HostedSessionTransactions & {
  sessions: FileSessionService;
  /** A host-authenticated local activity may persist its pending observation before releasing admission. */
  saveDuringActivity(value: Session, ownsActivity: () => boolean): Promise<void>;
  prepare: HostedRegistryOptions["prepare"];
  archiveRecovery: NonNullable<HostedRegistryOptions["archiveRecovery"]>;
  acceptOperator: NonNullable<HostedRegistryOptions["acceptOperator"]>;
  prepareOperator: NonNullable<HostedRegistryOptions["prepareOperator"]>;
  pendingOperators: NonNullable<HostedRegistryOptions["pendingOperators"]>;
  deliverOperator: NonNullable<HostedRegistryOptions["deliverOperator"]>;
  discoverDeliveries: NonNullable<HostedRegistryOptions["discoverDeliveries"]>;
  /** Repair turn bookkeeping from physical proof and any durable domain-owned preparation. */
  recoverSettlement: NonNullable<HostedRegistryOptions["recoverSettlement"]>;
} {
  const active = new Set<string>();
  const mutations = new Map<string, Promise<void>>();
  let queuedMutations = 0;
  const preparing = new Set<string>();
  const now = options.now ?? Date.now;
  const goalChanged = (session: Session): void => {
    if (session.goal_state === undefined) return;
    try {
      options.goalChanged?.(session.id);
    } catch {
      (options.logger ?? NOOP_LOGGER).warn(
        { event: "goal.change.delivery_failed", session_id: session.id },
        "Goal change observer failed",
      );
    }
  };
  const scoped = (session: Session): void => {
    if (session.workspace !== options.workspaceId || session.project_id !== options.projectId)
      throw kernelError("invalid_request", "hosted conversation belongs to a different workspace");
  };
  const locked = async <T>(id: string, action: () => Promise<T>): Promise<T> => {
    if (typeof id !== "string" || id.length === 0 || id.length > 256)
      throw kernelError("invalid_request", "invalid conversation identity");
    if (queuedMutations >= 64)
      throw kernelError("resource_exhausted", "hosted conversation mutation queue is full");
    queuedMutations++;
    const previous = mutations.get(id) ?? Promise.resolve();
    const settled = Promise.withResolvers<void>();
    mutations.set(id, settled.promise);
    await previous;
    active.add(id);
    try {
      return await action();
    } finally {
      queuedMutations--;
      active.delete(id);
      if (mutations.get(id) === settled.promise) mutations.delete(id);
      settled.resolve();
    }
  };
  const get = async (id: string): Promise<Session | null> => {
    const value = await options.sessions.get(id);
    if (value === null) return null;
    scoped(value);
    return { ...value, revision: revision(value) };
  };
  const save = (value: Session, ownsActivity?: () => boolean): Promise<void> => {
    const input = structuredClone(value);
    const assertWritable = (): void => {
      if (options.occupied(input.id) && ownsActivity?.() !== true)
        throw kernelError("conflict", "conversation has active hosted work");
    };
    return locked(input.id, async () => {
      assertWritable();
      scoped(input);
      const current = await get(input.id);
      assertWritable();
      if (revision(input) !== revision(current))
        throw kernelError("conflict", "conversation revision changed; reload before saving");
      if (
        current !== null &&
        (current.agent_instance_id !== input.agent_instance_id ||
          JSON.stringify(current.turns) !== JSON.stringify(input.turns) ||
          JSON.stringify(current.totals) !== JSON.stringify(input.totals) ||
          JSON.stringify(current.goal_state) !== JSON.stringify(input.goal_state) ||
          (input.operator_intents !== undefined &&
            JSON.stringify(current.operator_intents) !== JSON.stringify(input.operator_intents)) ||
          (input.operator_sequence !== undefined &&
            current.operator_sequence !== input.operator_sequence))
      )
        throw kernelError("conflict", "hosted turn history and totals are owned by the host");
      if (
        current === null &&
        (input.turns.length !== 0 ||
          input.totals.input !== 0 ||
          input.totals.output !== 0 ||
          input.goal_state !== undefined ||
          input.operator_intents !== undefined ||
          input.operator_sequence !== undefined)
      )
        throw kernelError("invalid_request", "new hosted conversations must have empty history");
      await options.sessions.save({
        ...input,
        ...(current?.operator_intents === undefined
          ? {}
          : {
              operator_intents: current.operator_intents,
              operator_sequence: current.operator_sequence,
            }),
        revision: revision(current) + 1,
      });
    });
  };
  const sessions: FileSessionService = {
    listPage: (page, scan) => options.sessions.listPage(page, scan),
    async list() {
      return (await options.sessions.list()).map((value) => ({
        ...value,
        revision: revision(value),
      }));
    },
    get,
    save: (value) => save(value),
    delete(id) {
      return locked(id, async () => {
        if (options.occupied(id))
          throw kernelError("conflict", "cannot delete a conversation with active hosted work");
        return options.sessions.delete(id);
      });
    },
  };

  const prepare: HostedRegistryOptions["prepare"] = async (input, authority) => {
    if (preparing.has(input.session_id))
      throw kernelError("conflict", "conversation preparation already in progress");
    if (preparing.size >= 4)
      throw kernelError("resource_exhausted", "hosted conversation preparation limit reached");
    preparing.add(input.session_id);
    try {
      authority.signal.throwIfAborted();
      const current = await locked(input.session_id, () => get(input.session_id));
      if (current === null) throw kernelError("not_found", "hosted conversation does not exist");
      /**
       * An archived recovery parks the conversation; a `continue` one reopens it.
       *
       * @remarks The operator's attestation is the same in both cases — nothing is still running —
       *   and what differs is only whether the line of work resumes here. Recording the resolution
       *   alone therefore cannot decide this: a conversation resolved with `continue` has to accept
       *   the successor the operator asked for, and the interrupted turn stays in its history as
       *   the base that successor continues from.
       */
      if (
        current.turns.some(
          (turn) =>
            turn.recovery_resolution !== undefined &&
            turn.recovery_resolution.disposition !== "continue",
        )
      )
        throw kernelError(
          "conflict",
          "conversation was archived after an unknown outcome; start a new conversation",
        );
      if (input.params.intent !== "operator" && revision(current) !== input.session_revision)
        throw kernelError("conflict", "conversation changed before hosted turn admission");
      if (current.turns.some((turn) => turn.execution_id === input.params.execution_id))
        throw kernelError("conflict", "execution already belongs to this conversation");
      const previous = current.turns.findLast(
        (turn) => turn.kind === "conversation" && turn.execution_id !== undefined,
      );
      if (
        input.params.continue_from !== undefined &&
        (input.kind !== "conversation" || input.params.continue_from !== previous?.execution_id)
      )
        throw kernelError(
          "conflict",
          "continuation does not name this conversation's latest model turn",
        );
      const params = structuredClone(input.params);
      const batch =
        params.intent === "operator" &&
        params.skill === undefined &&
        params.goal_intent === undefined
          ? (current.operator_intents ?? []).filter(
              (receipt) =>
                !receipt.admitted &&
                (receipt.execution_id === params.execution_id ||
                  !receipt.execution_id.startsWith("steer_")) &&
                receipt.input.kind === input.kind &&
                operatorPolicy(receipt.input.params) === operatorPolicy(params) &&
                receipt.input.params.skill === undefined &&
                receipt.input.params.goal_intent === undefined,
            )
          : [];
      if (batch.length > 0)
        params.messages = batch.flatMap((receipt) =>
          structuredClone(receipt.input.params.messages),
        );
      if (previous?.recovery_resolution?.disposition === "continue") {
        const history: StartRunParams["messages"] = [];
        for (const turn of current.turns) {
          if (turn.kind !== "conversation" || turn.execution_id === undefined) continue;
          const detail = await options.readRun?.(turn.execution_id);
          if (detail !== null && detail !== undefined) {
            history.push(...detail.messages);
            if (typeof detail.result?.result === "string" && detail.result.result.trim())
              history.push({ role: "assistant", content: detail.result.result });
            const recovered = buildRecoveredContext(detail.events, detail.plan_ref);
            if (recovered !== null) history.push({ role: "assistant", content: recovered });
          }
        }
        history.push({
          role: "user",
          content:
            "The previous execution was physically closed through explicit recovery. Its outcome may be incomplete. Verify uncertain effects before repeating actions; no successful outcome is implied.",
        });
        if (Buffer.byteLength(JSON.stringify(history)) > 512 * 1024)
          throw kernelError(
            "resource_exhausted",
            "Recovered conversation exceeds its context bound",
          );
        params.messages = [...history, ...params.messages];
        delete params.continue_from;
      }
      const agentInstanceId = current.agent_instance_id ?? randomUUID();
      params.session_id = current.id;
      params.agent_instance_id = input.kind === "conversation" ? agentInstanceId : randomUUID();
      if (input.kind === "conversation" && current.pending !== undefined) {
        const insertion =
          params.skill === undefined && params.messages.at(-1)?.role === "user"
            ? params.messages.length - 1
            : params.messages.length;
        params.messages.splice(insertion, 0, ...current.pending);
      }
      const binding = await options.prepareExecution(params, {
        session: structuredClone(current),
        signal: authority.signal,
        conversation: authority.conversation,
        ...(authority.continuationOf === undefined
          ? {}
          : { continuationOf: authority.continuationOf }),
      });
      authority.signal.throwIfAborted();
      const latest = await get(input.session_id);
      if (preparationIdentity(current) !== preparationIdentity(latest))
        throw kernelError("conflict", "conversation changed while execution was being prepared");
      const stamp = now();
      const intent: Session = {
        ...current,
        agent_instance_id: agentInstanceId,
        ...(input.kind === "conversation" ? { agent_profile: binding.config.agent } : {}),
        revision: revision(current) + 1,
        updated_at: stamp,
        turns: [
          ...current.turns,
          {
            kind: input.kind,
            execution_id: params.execution_id,
            user_preview: options.redact(input.user_preview).slice(0, 4096),
            status: "running",
            started_at: stamp,
            ...(binding.config.extension_profile === undefined
              ? {}
              : { extension_profile: binding.config.extension_profile }),
          },
        ],
      };
      if (input.kind === "conversation") delete intent.pending;
      let committed = false;
      let started = false;
      return {
        ...binding,
        title: options.redact(current.title).slice(0, 256),
        commitIntent() {
          return locked(input.session_id, async () => {
            authority.signal.throwIfAborted();
            if (committed) throw kernelError("conflict", "hosted turn intent already committed");
            const latest = await get(input.session_id);
            if (latest === null || preparationIdentity(latest) !== preparationIdentity(current))
              throw kernelError("conflict", "conversation changed before intent commit");
            intent.operator_intents = latest.operator_intents;
            intent.operator_sequence = latest.operator_sequence;
            intent.revision = revision(latest) + 1;
            binding.commitSessionIntent?.(intent);
            const receipt = intent.operator_intents?.find(
              (value) => value.execution_id === params.execution_id,
            );
            if (receipt !== undefined) {
              receipt.admitted = true;
              receipt.delivered_to = params.execution_id;
            }
            for (const accepted of batch) {
              const member = intent.operator_intents?.find(
                (value) => value.execution_id === accepted.execution_id,
              );
              if (member !== undefined) {
                member.admitted = true;
                member.delivered_to = params.execution_id;
              }
            }
            await options.sessions.saveHost(intent);
            goalChanged(intent);
            committed = true;
          });
        },
        start() {
          authority.signal.throwIfAborted();
          if (!committed) throw kernelError("conflict", "hosted turn intent is not committed");
          if (started) throw kernelError("conflict", "hosted turn cannot start twice");
          started = true;
          return binding.start();
        },
        async reconcile(result) {
          if (!["completed", "failed", "cancelled"].includes(result.status))
            throw kernelError(
              "invalid_request",
              "hosted reconciliation requires a terminal result",
            );
          if (result.execution_id !== params.execution_id)
            throw kernelError("conflict", "result does not belong to this hosted turn");
          const decision = await binding.prepareSettlement?.(result);
          const settle = (session: Session): boolean =>
            decision?.(session) === true || options.settleSession?.(session, result) === true;
          return locked(input.session_id, async () => {
            const stored = await get(input.session_id);
            const turn = stored?.turns.find((value) => value.execution_id === params.execution_id);
            if (
              !committed &&
              turn === undefined &&
              JSON.stringify(stored) === JSON.stringify(current)
            )
              return;
            if (stored === null || turn === undefined)
              throw kernelError("conflict", "hosted turn intent disappeared before reconciliation");
            if (turn.ended_at !== undefined) {
              const before = JSON.stringify(stored);
              settle(stored);
              if (before !== JSON.stringify(stored)) {
                stored.revision = revision(stored) + 1;
                stored.updated_at = now();
                await options.sessions.saveHost(stored);
                goalChanged(stored);
              }
              return;
            }
            if (input.kind === "transcript" && params.skill !== undefined) {
              const detail = await options.readRun?.(params.execution_id);
              const digest = buildSkillRunDigest(
                params.skill.name,
                binding.config.agent,
                result,
                detail ?? null,
              );
              stored.pending = [...(stored.pending ?? []), { role: "assistant", content: digest }];
            }
            turn.status =
              result.status === "completed"
                ? "done"
                : result.status === "cancelled" || result.ended_reason === "soft_limit_declined"
                  ? "cancelled"
                  : "error";
            turn.ended_at = now();
            stored.updated_at = turn.ended_at;
            stored.revision = revision(stored) + 1;
            const settled = settle(stored);
            if (!settled)
              addRunUsage(stored.totals, result.usage, (model) => options.priceFor?.(model));
            await options.sessions.saveHost(stored);
            goalChanged(stored);
          });
        },
      };
    } finally {
      preparing.delete(input.session_id);
    }
  };
  const recoverSettlement: NonNullable<HostedRegistryOptions["recoverSettlement"]> = (
    run,
    checkpoint,
  ) =>
    locked(run.session_id, async () => {
      if (
        checkpoint.physical_closed !== true ||
        checkpoint.operation !== "reconcile" ||
        run.outcome === undefined ||
        run.outcome.status === "running"
      )
        throw kernelError(
          "invalid_request",
          "recovery requires a durable terminal physical checkpoint",
        );
      if (run.workspace_id !== options.workspaceId)
        throw kernelError("conflict", "recovery belongs to another workspace");
      const stored = await get(run.session_id);
      if (stored === null) return false;
      const turn = stored.turns.find((item) => item.execution_id === run.execution_id);
      if (turn === undefined) return false;
      if (turn.ended_at !== undefined) return true;
      const goals = [
        ...(stored.goal_state?.archive ?? []),
        ...(stored.goal_state?.current === undefined ? [] : [stored.goal_state.current]),
      ];
      if (
        turn.kind !== "conversation" ||
        turn.recovery_resolution !== undefined ||
        options.settleSession !== undefined ||
        stored.goal_state?.creation_intent?.execution_id === run.execution_id
      )
        return false;
      const result: RunResult = { execution_id: run.execution_id, ...run.outcome };
      const boundGoal = goals.some((goal) =>
        goal.runs.some((item) => item.execution_id === run.execution_id),
      );
      const settledGoal =
        boundGoal &&
        recoverGoalSettlementSession(stored, result, now(), (model) => options.priceFor?.(model));
      if (boundGoal && !settledGoal) return false;
      turn.status =
        result.status === "completed"
          ? "done"
          : result.status === "cancelled" || result.ended_reason === "soft_limit_declined"
            ? "cancelled"
            : "error";
      turn.ended_at = now();
      stored.updated_at = turn.ended_at;
      stored.revision = revision(stored) + 1;
      if (!settledGoal)
        addRunUsage(stored.totals, result.usage, (model) => options.priceFor?.(model));
      await options.sessions.saveHost(stored);
      (options.logger ?? NOOP_LOGGER).info(
        {
          event: "hosting.settlement.canonical_recovered",
          execution_id: run.execution_id,
          host_generation: run.host_generation,
          operation: "reconcile",
          scope: "session",
          attempt: checkpoint.attempt,
          transition: "reconciled",
        },
        "physically closed session settlement recovered",
      );
      goalChanged(stored);
      return true;
    });

  const archiveRecovery: NonNullable<HostedRegistryOptions["archiveRecovery"]> = (
    run,
    resolution,
  ) =>
    locked(run.session_id, async () => {
      const stored = await get(run.session_id);
      if (stored === null) throw kernelError("not_found", "recovery conversation does not exist");
      let turn = stored.turns.find((value) => value.execution_id === run.execution_id);
      if (turn?.recovery_resolution !== undefined) {
        if (turn.recovery_resolution.previous_host_generation !== run.host_generation)
          throw kernelError("conflict", "recovery audit belongs to a different host generation");
        return structuredClone(turn.recovery_resolution);
      }
      if (turn === undefined) {
        turn = {
          kind: "transcript",
          execution_id: run.execution_id,
          user_preview: options.redact(run.title).slice(0, 4096),
          status: "interrupted",
        };
        stored.turns.push(turn);
      }
      if (turn.status === "running" || turn.status === "pending") turn.status = "interrupted";
      turn.recovery_resolution = structuredClone(resolution);
      stored.revision = revision(stored) + 1;
      stored.updated_at = now();
      await options.sessions.save(stored);
      return structuredClone(resolution);
    });
  const transact: HostedSessionTransactions["transact"] = (sessionId, mutation) =>
    locked(sessionId, async () => {
      const current = await get(sessionId);
      if (current === null) throw kernelError("not_found", "hosted conversation does not exist");
      const { session, result } = mutation(structuredClone(current));
      scoped(session);
      if (session.id !== sessionId || revision(session) !== revision(current))
        throw kernelError(
          "conflict",
          "host mutation cannot change conversation identity or revision",
        );
      if (JSON.stringify(session) === JSON.stringify(current)) return result;
      await options.sessions.saveHost({
        ...session,
        revision: revision(current) + 1,
        updated_at: now(),
      });
      goalChanged(session);
      return result;
    });
  const acceptOperator: NonNullable<HostedRegistryOptions["acceptOperator"]> = (
    input,
    steeringTarget,
  ) =>
    transact(input.session_id, (session) => {
      const canonical = structuredClone(input);
      canonical.session_revision = 0;
      delete canonical.params.continue_from;
      const fingerprint = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
      const known = session.operator_intents?.find(
        (value) => value.execution_id === input.params.execution_id,
      );
      if (known !== undefined) {
        if (
          known.fingerprint !== fingerprint ||
          (steeringTarget !== undefined && known.steering_target !== steeringTarget)
        )
          throw kernelError(
            "conflict",
            "Submission identity was reused for different input or target",
          );
        return { session, result: known.admitted ? ("delivered" as const) : ("pending" as const) };
      }
      if (
        steeringTarget !== undefined &&
        (!input.params.execution_id.startsWith("steer_") ||
          !session.turns.some((turn) => turn.execution_id === steeringTarget))
      )
        throw kernelError(
          "conflict",
          "Steering destination is not a recorded conversation execution",
        );
      const intents = session.operator_intents ?? [];
      if (intents.filter((value) => !value.admitted).length >= 16)
        throw kernelError("resource_exhausted", "Too many pending operator submissions");
      const goalState = goalStateFromSession(session);
      if (goalState !== undefined)
        session.goal_state = goalStateToDto(
          pauseGoalForPolicy(
            goalState,
            "New operator input suspended automatic continuation",
            now(),
          ),
        );
      session.operator_sequence = (session.operator_sequence ?? 0) + 1;
      session.operator_intents = [
        ...intents.filter(
          (value) => !value.admitted || intents.indexOf(value) >= intents.length - 48,
        ),
        {
          execution_id: input.params.execution_id,
          sequence: session.operator_sequence,
          fingerprint,
          input: structuredClone(input),
          accepted_at: now(),
          ...(steeringTarget === undefined ? {} : { steering_target: steeringTarget }),
        },
      ];
      return { session, result: "pending" as const };
    });
  const deliverOperator: NonNullable<HostedRegistryOptions["deliverOperator"]> = (
    sessionId,
    executionId,
    deliveredTo,
  ) =>
    transact(sessionId, (session) => {
      const receipt = session.operator_intents?.find((value) => value.execution_id === executionId);
      if (receipt === undefined) throw kernelError("conflict", "Steering receipt disappeared");
      if (receipt.steering_target !== undefined && receipt.steering_target !== deliveredTo)
        throw kernelError(
          "conflict",
          "Steering consumption does not match its accepted destination",
        );
      if (receipt.delivered_to !== undefined && receipt.delivered_to !== deliveredTo)
        throw kernelError("conflict", "Steering already consumed by another execution");
      receipt.admitted = true;
      receipt.delivered_to = deliveredTo;
      return { session, result: undefined };
    });
  const discoverDeliveries: NonNullable<HostedRegistryOptions["discoverDeliveries"]> = async (
    run,
  ) => {
    if (run.workspace_id !== options.workspaceId)
      throw kernelError("conflict", "steering recovery belongs to another workspace");
    const session = await get(run.session_id);
    const pending =
      session?.operator_intents?.filter(
        (receipt) => !receipt.admitted && receipt.steering_target === run.execution_id,
      ) ?? [];
    if (pending.length === 0) return [];
    const detail = await options.readRun?.(run.execution_id);
    return pending
      .filter((receipt) =>
        detail?.events.some(
          (event) => event.type === "steering_applied" && event.id === receipt.execution_id,
        ),
      )
      .map((receipt) => receipt.execution_id);
  };
  const prepareOperator: NonNullable<HostedRegistryOptions["prepareOperator"]> = async (
    sessionId,
    executionId,
  ) => {
    const session = await get(sessionId);
    const receipt = session?.operator_intents?.find((value) => value.execution_id === executionId);
    if (session === null || receipt === undefined)
      throw kernelError("not_found", "Operator submission is not durably accepted");
    if (!receipt.admitted && executionId.startsWith("steer_")) {
      let incomplete = false;
      const executions =
        receipt.steering_target === undefined
          ? session.turns.map((turn) => turn.execution_id).reverse()
          : [receipt.steering_target];
      for (const target of executions) {
        if (target === undefined) continue;
        const detail = await options.readRun?.(target);
        if (
          detail?.events.some(
            (event) => event.type === "steering_applied" && event.id === executionId,
          )
        ) {
          await deliverOperator(sessionId, executionId, target);
          throw kernelError("conflict", "Submission consumption recovered from canonical history", {
            submission: "admitted",
            execution_id: target,
          });
        }
        if (
          detail == null ||
          detail.recovery !== undefined ||
          !["completed", "failed", "cancelled"].includes(detail.status)
        )
          incomplete = true;
      }
      if (incomplete)
        throw kernelError("unavailable", "Steering consumption awaits complete canonical history", {
          submission: "recovering",
          execution_id: executionId,
        });
    }
    if (receipt.admitted)
      throw kernelError(
        "conflict",
        "Submission already admitted; recover its canonical execution",
        { submission: "admitted", execution_id: receipt.delivered_to ?? executionId },
      );
    const input = structuredClone(receipt.input);
    input.session_revision = revision(session);
    const previous = session.turns.findLast(
      (turn) => turn.kind === "conversation" && turn.execution_id !== undefined,
    );
    if (previous?.execution_id !== undefined && input.params.skill === undefined)
      input.params.continue_from = previous.execution_id;
    return input;
  };
  return {
    sessions,
    saveDuringActivity: save,
    prepare,
    archiveRecovery,
    transact,
    acceptOperator,
    async pendingOperators(sessionId) {
      const session = await get(sessionId);
      return (session?.operator_intents ?? [])
        .filter((receipt) => !receipt.admitted)
        .sort((left, right) => left.sequence - right.sequence)
        .map((receipt) => structuredClone(receipt.input));
    },
    prepareOperator,
    deliverOperator,
    discoverDeliveries,
    recoverSettlement,
  };
}
