import type {
  ModelCost,
  RunResult,
  RunDetail,
  Session,
  SessionTotals,
  StartRunParams,
} from "@clarvis/protocol";
import type { HostedRegistryOptions, PreparedHostedTurn } from "./registry.ts";
import { kernelError } from "../core/errors.ts";
import type { FileSessionService } from "../sessions/session-service.ts";
import { buildSkillRunDigest } from "../runs/recovered-context.ts";

/** An immutable execution binding prepared without starting inference or consuming a run stream. */
export type HostedExecutionBinding = Omit<
  PreparedHostedTurn,
  "title" | "reconcile" | "commitIntent"
>;

/** Canonical conversation stores and immutable run preparation supplied by the owning file host. */
export interface HostedSessionOptions {
  sessions: FileSessionService;
  workspaceId: string;
  projectId: string;
  occupied(sessionId: string): boolean;
  prepareExecution(params: StartRunParams): Promise<HostedExecutionBinding>;
  redact(text: string): string;
  priceFor?(model: string): ModelCost | undefined;
  /** Canonical result/trace used for a separately invoked skill's pending conversation digest. */
  readRun?(executionId: string): Promise<RunDetail | null>;
  now?: () => number;
}

function revision(session: Session | null): number {
  const value = session?.revision ?? 0;
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER)
    throw kernelError("invalid_request", "invalid or exhausted hosted conversation revision");
  return value;
}

/** Preserve the existing measured/unknown cache semantics without inventing model prices. */
function addUsage(
  totals: SessionTotals,
  result: RunResult,
  priceFor: HostedSessionOptions["priceFor"],
): void {
  const usage = result.usage;
  if (usage === undefined) return;
  if (usage.by_agent === undefined) {
    const input = usage.input_tokens ?? 0;
    totals.input += input;
    totals.output += usage.output_tokens ?? 0;
    if (totals.cached !== undefined) {
      if (usage.cached_tokens !== undefined) totals.cached += usage.cached_tokens;
      else if (input > 0) delete totals.cached;
    }
    return;
  }
  for (const agent of usage.by_agent) {
    totals.input += agent.input_tokens;
    totals.output += agent.output_tokens;
    if (totals.cached !== undefined) totals.cached += agent.cached_tokens;
    const price = priceFor?.(agent.model);
    if (price === undefined) continue;
    const fresh = Math.max(0, agent.input_tokens - agent.cached_tokens);
    const cost =
      (fresh * price.input +
        agent.output_tokens * price.output +
        agent.cached_tokens * (price.cache_read ?? price.input) +
        (agent.cache_write_tokens ?? 0) * (price.cache_write ?? price.input)) /
      1e6;
    totals.cost_usd = (totals.cost_usd ?? 0) + cost;
  }
}

/**
 * Own hosted turn intent and settlement on the existing session document. Interactive saves may
 * edit metadata/pending observations between activities or under their own local activity lease,
 * and only at the observed revision. Execution history and totals remain exclusively host-owned.
 * Locks reserve before the first await and never retain an unbounded queue of stale UI documents.
 */
export function createHostedSessionCoordinator(options: HostedSessionOptions): {
  sessions: FileSessionService;
  /** A host-authenticated local activity may persist its pending observation before releasing admission. */
  saveDuringActivity(value: Session, ownsActivity: () => boolean): Promise<void>;
  prepare: HostedRegistryOptions["prepare"];
} {
  const active = new Set<string>();
  const now = options.now ?? Date.now;
  const scoped = (session: Session): void => {
    if (session.workspace !== options.workspaceId || session.project_id !== options.projectId)
      throw kernelError("invalid_request", "hosted conversation belongs to a different workspace");
  };
  const locked = async <T>(id: string, action: () => Promise<T>): Promise<T> => {
    if (typeof id !== "string" || id.length === 0 || id.length > 256)
      throw kernelError("invalid_request", "invalid conversation identity");
    if (active.has(id)) throw kernelError("conflict", "conversation mutation already in progress");
    if (active.size >= 4)
      throw kernelError("resource_exhausted", "hosted conversation mutation limit reached");
    active.add(id);
    try {
      return await action();
    } finally {
      active.delete(id);
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
        (JSON.stringify(current.turns) !== JSON.stringify(input.turns) ||
          JSON.stringify(current.totals) !== JSON.stringify(input.totals))
      )
        throw kernelError("conflict", "hosted turn history and totals are owned by the host");
      if (
        current === null &&
        (input.turns.length !== 0 || input.totals.input !== 0 || input.totals.output !== 0)
      )
        throw kernelError("invalid_request", "new hosted conversations must have empty history");
      await options.sessions.save({ ...input, revision: revision(current) + 1 });
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

  const prepare: HostedRegistryOptions["prepare"] = (input, authority) =>
    locked(input.session_id, async () => {
      authority.signal.throwIfAborted();
      const current = await get(input.session_id);
      if (current === null) throw kernelError("not_found", "hosted conversation does not exist");
      if (revision(current) !== input.session_revision)
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
      params.configuration_session_id = authority.scope;
      if (input.kind === "conversation" && current.pending !== undefined) {
        const insertion =
          params.skill === undefined && params.messages.at(-1)?.role === "user"
            ? params.messages.length - 1
            : params.messages.length;
        params.messages.splice(insertion, 0, ...current.pending);
      }
      const binding = await options.prepareExecution(params);
      authority.signal.throwIfAborted();
      const latest = await get(input.session_id);
      if (JSON.stringify(current) !== JSON.stringify(latest))
        throw kernelError("conflict", "conversation changed while execution was being prepared");
      const stamp = now();
      const intent: Session = {
        ...current,
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
            if (JSON.stringify(await get(input.session_id)) !== JSON.stringify(current))
              throw kernelError("conflict", "conversation changed before intent commit");
            await options.sessions.save(intent);
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
        reconcile(result) {
          return locked(input.session_id, async () => {
            if (!["completed", "failed", "cancelled"].includes(result.status))
              throw kernelError(
                "invalid_request",
                "hosted reconciliation requires a terminal result",
              );
            if (result.execution_id !== params.execution_id)
              throw kernelError("conflict", "result does not belong to this hosted turn");
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
            if (turn.ended_at !== undefined) return;
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
            addUsage(stored.totals, result, (model) => options.priceFor?.(model));
            await options.sessions.save(stored);
          });
        },
      };
    });
  return { sessions, saveDuringActivity: save, prepare };
}
