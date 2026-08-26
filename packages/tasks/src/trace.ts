import type { PersistedTraceProjector, TracePort } from "@clarvis/capability";
import { sanitizeErrorMessage } from "@clarvis/capability";
import { sanitizeTaskText } from "./active-task.ts";

export const TASK_TRACE_KINDS = [
  "task_bound",
  "task_operation_started",
  "task_operation_completed",
  "task_operation_failed",
  "task_conflict",
  "task_claimed",
  "task_outcome_unknown",
] as const;

export type TaskTraceKind = (typeof TASK_TRACE_KINDS)[number];

export interface TaskTraceDetail {
  provider_key: string;
  task_id: string;
  operation: string;
  execution_id?: string;
  actor_id?: string;
  actor_kind?: string;
  started_at?: number;
  ended_at?: number;
  previous_revision?: string;
  new_revision?: string;
  result?: string;
  code?: string;
  idempotency_digest?: string;
  /**
   * The provider's own stated reason for a refusal, carried only by the three
   * failure kinds and only through {@link boundedProviderMessage}.
   */
  message?: string;
}

/**
 * The trace kinds whose detail may carry a provider-authored `message`.
 *
 * @remarks Deliberately three of seven rather than all of them. `task_bound`,
 *   `task_operation_started`, `task_operation_completed` and `task_claimed`
 *   describe a call that did what it was asked, so their only source of a
 *   `message` would be a field an earlier detail happened to carry forward —
 *   widening the allowlist for them would admit untrusted remote text onto the
 *   record with nothing to explain. A refusal is the one place the code alone
 *   is not actionable.
 */
const MESSAGE_BEARING_KINDS: ReadonlySet<string> = new Set<TaskTraceKind>([
  "task_operation_failed",
  "task_conflict",
  "task_outcome_unknown",
]);

/**
 * Character ceiling for a provider-authored `message` on the persisted trace.
 *
 * @remarks Matches `@clarvis/trace`'s `SUMMARY_MAX`, the cap that package puts
 *   on short summaries and degradation reasons — the closest analogue to a
 *   remote system's stated reason for refusing a write. The value is restated
 *   rather than imported because `@clarvis/tasks` depends on the capability
 *   contract alone. A registered projector's output bypasses `capDetail`
 *   entirely, so this is the only bound on the field.
 */
export const TASK_TRACE_MESSAGE_MAX = 500;

/** Marker kept inside {@link TASK_TRACE_MESSAGE_MAX}, so re-capping is a no-op. */
const TRUNCATION_MARKER = "…";

/**
 * Normalize, redact and bound one provider-authored reason.
 *
 * @param value - the candidate field from an untrusted trace detail.
 * @returns the sanitized, single-line, length-bounded text, or `undefined` when
 *   the value is not a non-empty string.
 * @remarks {@link sanitizeTaskText} first, because a remote party authored this
 *   and control or ANSI bytes must not reach a durable record or the terminal
 *   that renders it; then {@link sanitizeErrorMessage}, which is the only pass
 *   applying the coarse high-entropy rule — a registered projector's result is
 *   sanitized with `sanitizeToolPayload`, which deliberately omits it. Whitespace
 *   is collapsed the way `@clarvis/llm` collapses a provider's error body, so one
 *   refusal stays one line of record.
 */
function boundedProviderMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = sanitizeErrorMessage(sanitizeTaskText(value)).replace(/\s+/gu, " ").trim();
  if (text.length === 0) return undefined;
  if (text.length <= TASK_TRACE_MESSAGE_MAX) return text;
  return text.slice(0, TASK_TRACE_MESSAGE_MAX - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeDetail(value: unknown, allowMessage: boolean): TaskTraceDetail | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.provider_key !== "string" ||
    typeof value.task_id !== "string" ||
    typeof value.operation !== "string"
  ) {
    return null;
  }
  const allowed = [
    "provider_key",
    "task_id",
    "operation",
    "execution_id",
    "actor_id",
    "actor_kind",
    "started_at",
    "ended_at",
    "previous_revision",
    "new_revision",
    "result",
    "code",
    "idempotency_digest",
  ] as const;
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    const child = value[key];
    if (typeof child === "string" || typeof child === "number") out[key] = child;
  }
  if (allowMessage) {
    const message = boundedProviderMessage(value.message);
    if (message !== undefined) out.message = message;
  }
  return out as unknown as TaskTraceDetail;
}

export function recordTaskTrace(
  trace: TracePort,
  kind: TaskTraceKind,
  detail: TaskTraceDetail,
): void {
  trace.record(kind, detail);
}

export const TASK_PERSISTED_TRACE_PROJECTORS: readonly PersistedTraceProjector[] =
  TASK_TRACE_KINDS.map((kind) => {
    const allowMessage = MESSAGE_BEARING_KINDS.has(kind);
    return {
      kind,
      project(entry, context) {
        const detail = safeDetail(entry.detail, allowMessage);
        if (detail === null) return null;
        const at = context.absoluteTime(entry.at);
        return { type: kind, at, ...detail };
      },
    };
  });
