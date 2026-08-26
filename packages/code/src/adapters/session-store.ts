import type {
  Message,
  RunStatus,
  RunUsage,
  Session,
  SessionService,
  SessionSummary,
} from "@clarvis/protocol";
import { sanitizeErrorMessage, sanitizeText } from "@clarvis/kernel/policy";
import { glyph } from "../core/marks.ts";
import type { CatalogCost } from "./models-catalog.ts";

/** A session's stable identity. */
export type SessionId = string;

/** A turn's or transcript node's lifecycle status, as tracked in session metadata. */
export type NodeStatus = "pending" | "running" | "done" | "error" | "cancelled" | "interrupted";

/** A session's running token/cost totals, accumulated across its turns. */
export interface SessionTotals {
  input: number;
  output: number;
  cached: number;
  costUsd?: number;
}

/** One turn (user message + run) within a session. */
export interface TurnRef {
  userPreview: string;
  executionId?: string;
  status: NodeStatus;
  startedAt?: number;
  endedAt?: number;
  /**
   * Why the run failed, when it did: the `{code, message}` the kernel preserves
   * on a failed run's envelope, masked and bounded by {@link redactTurnError}.
   * Absent on every non-failed turn.
   *
   * @remarks It is persisted with the turn — see {@link PersistedSessionTurn}
   *   for why the wire shape has to be widened to carry it. A run that got as
   *   far as producing a response does leave a trace record whose
   *   `result.error` says the same thing, so for those this is a convenience;
   *   for a run that fails *before* one is written — a rejected continuation, a
   *   failed persist, an unavailable kernel, a crash — it is the only thing a
   *   reloaded session can say about why it failed.
   */
  error?: { code: string; message: string };
}

/** A session's persisted metadata: its turns, totals, and any unflushed pending messages. */
export interface SessionMeta {
  id: SessionId;
  title: string;
  /** Required before persistence; optional only for unpersisted view projections. */
  projectId?: string;
  workspace: string;
  owner: string;
  createdAt: number;
  updatedAt: number;
  profile?: string;
  turns: TurnRef[];
  /** Catalog-only count when the full turn index has not been loaded yet. */
  turnCount?: number;
  totals: SessionTotals;
  pending?: Message[];
}

/**
 * Map a protocol {@link RunStatus} to the UI's {@link NodeStatus}, treating a
 * declined soft-limit continuation as a cancellation rather than an error.
 */
export function runStatusToNode(status: RunStatus, endedReason?: string): NodeStatus {
  switch (status) {
    case "completed":
      return "done";
    case "cancelled":
      return "cancelled";
    case "running":
      return "running";
    default:
      return endedReason === "soft_limit_declined" ? "cancelled" : "error";
  }
}

/** Generate a UUIDv7 (time-ordered: a 48-bit millisecond timestamp prefix plus random bits). */
export function uuidv7(): string {
  const ts = Date.now();
  const bytes = new Uint8Array(16);
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  crypto.getRandomValues(bytes.subarray(6));
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Build a session/turn preview from `text`'s first line: secret-shaped
 * substrings are masked (unless `redact: false`), then the result is truncated
 * to `max` characters with an ellipsis.
 *
 * @remarks Masking uses `@clarvis/capability`'s `sanitizeText` through the
 *   kernel's re-export — the rule set for free text bound for the disk, which is
 *   exactly what a preview is: it is persisted as a session title and only ever
 *   read back, never replayed as a file's contents, so it wants the reach of the
 *   unquoted key/value rule and the coarse high-entropy fallback rather than the
 *   narrower trace rules. Redaction runs on the first line and before truncation,
 *   so a preview cut at `max` can never keep a prefix of the secret itself.
 *
 *   Previews already on disk are left exactly as they were written; only new
 *   ones go through these rules.
 */
export function redactPreview(text: string, opts: { redact?: boolean; max?: number } = {}): string {
  const max = opts.max ?? 200;
  const firstLine = text.split("\n", 1)[0] ?? "";
  const out = opts.redact === false ? firstLine : sanitizeText(firstLine);
  const ell = glyph("ellipsis");
  return out.length > max ? out.slice(0, max - ell.length) + ell : out;
}

/**
 * Default character bound for a persisted turn's failure message.
 *
 * @remarks Small enough that turn *count*, never one pathological message, is
 *   what could ever push a session document past the kernel's serialization cap
 *   — a document that no longer fits stops persisting for the rest of the
 *   session's life, and the failure is swallowed into the store's `onError`.
 */
export const TURN_ERROR_MAX_CHARS = 2000;

/**
 * Bound and redact a failed run's reason before it is recorded on a turn.
 *
 * @param error - the `{code, message}` the kernel put on the failed envelope.
 * @param opts - `redact: false` keeps the message verbatim, exactly as it
 *   suppresses masking for a preview; `max` overrides
 *   {@link TURN_ERROR_MAX_CHARS}.
 * @returns the same `code` with a masked, bounded `message`.
 * @remarks Applied at the producer — {@link createSession}'s `endTurn` — rather
 *   than inside {@link metaToSession}, so the value held in memory and the value
 *   written to disk are the same string and the two converters stay pure
 *   field-by-field maps. Uses the error-message rule set rather than
 *   {@link redactPreview}'s free-text one because that is what every other
 *   error-message site in the repository uses, and because the dominant thrown
 *   error path has already been through it; the two producers that have not are
 *   a mapped loop result and a kernel error built straight from a thrown
 *   `Error`. Newlines survive: a stack's later lines are the diagnostic value,
 *   which is the whole reason this reaches the disk at all.
 */
export function redactTurnError(
  error: { code: string; message: string },
  opts: { redact?: boolean; max?: number } = {},
): { code: string; message: string } {
  const max = opts.max ?? TURN_ERROR_MAX_CHARS;
  const message = opts.redact === false ? error.message : sanitizeErrorMessage(error.message);
  const ell = glyph("ellipsis");
  return {
    code: error.code,
    message: message.length > max ? message.slice(0, max - ell.length) + ell : message,
  };
}

/**
 * Fold a run's per-agent usage into a session's running {@link SessionTotals},
 * pricing each agent's fresh input, cached input, cache-write, and output
 * tokens separately when `priceFor` resolves a cost for its model.
 *
 * @param totals - the totals to mutate in place.
 * @param usage - the run's usage, broken down by agent; a no-op if absent.
 * @param priceFor - resolves a model's {@link CatalogCost}, if priced.
 */
export function addUsageToTotals(
  totals: SessionTotals,
  usage: RunUsage | undefined,
  priceFor?: (model: string) => CatalogCost | undefined,
): void {
  if (!usage?.by_agent) return;
  for (const a of usage.by_agent) {
    totals.input += a.input_tokens;
    totals.output += a.output_tokens;
    totals.cached += a.cached_tokens;
    const cost = priceFor?.(a.model);
    if (!cost) continue;
    const cacheRead = cost.cache_read ?? cost.input;
    const cacheWrite = cost.cache_write ?? cost.input;
    const cached = a.cached_tokens ?? 0;
    const cacheWriteTokens = a.cache_write_tokens ?? 0;
    const freshInput = Math.max(0, a.input_tokens - cached);
    const delta =
      (freshInput / 1e6) * cost.input +
      (a.output_tokens / 1e6) * cost.output +
      (cached / 1e6) * cacheRead +
      (cacheWriteTokens / 1e6) * cacheWrite;
    totals.costUsd = (totals.costUsd ?? 0) + delta;
  }
}

/**
 * The input tokens a session's provider actually had to read: every input token
 * it reported, less the ones its prefix cache served.
 *
 * @remarks {@link SessionTotals.input} is the gross count, cache hits included,
 * because pricing needs the two priced apart. Every surface that answers "how
 * much did this session read" states this net figure instead, so the number on
 * screen tracks the work rather than the bill.
 */
export function uncachedInput(totals: SessionTotals): number {
  return Math.max(0, totals.input - totals.cached);
}

/** Format a USD amount for display: 2 decimals at or above $1, else 4. */
export function formatCostUsd(usd: number): string {
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/**
 * The owner-scoped, kernel-backed session cache the UI reads and writes through.
 *
 * @remarks Owner-scoped by *construction*: {@link createSessionStore} binds one,
 *   and every entry in the cache belongs to it. The read methods therefore take
 *   no owner - they used to take one and ignore it, a signature that promised a
 *   scoping check no implementation performed. Serving a second owner means a
 *   second store.
 */
export interface SessionStore {
  list(): SessionMeta[];
  get(id: SessionId): SessionMeta | null;
  /** Fetch and cache the full session document on demand. */
  load(id: SessionId): Promise<SessionMeta | null>;
  save(meta: SessionMeta): void;
  delete(id: SessionId): boolean;
  /** Bounded cache and write-lane counters for the process-level memory ledger. */
  memory?(): {
    cached_sessions: number;
    full_sessions: number;
    pending_session_write_lanes: number;
    queued_session_writes: number;
  };
  /** Waits for optimistic background writes to reach the backing service. */
  flushPending?(): Promise<void>;
}

/**
 * Maximum number of complete session documents retained by the TUI cache.
 *
 * @remarks A cache bound, so eviction costs a re-`load` and never data: the
 * store keeps every session's metadata regardless, and only the full document —
 * the turn list, which grows without limit — is what gets released. Sized for
 * how many sessions a person moves between while working, which is a handful;
 * past that the switch is a deliberate navigation and can afford a read.
 */
export const MAX_RESIDENT_FULL_SESSIONS = 8;

/** List a store's sessions restricted to one workspace. */
export function listSessionsForWorkspace(store: SessionStore, workspace: string): SessionMeta[] {
  return store.list().filter((m) => m.workspace === workspace);
}

/**
 * A session turn as it is persisted: the wire shape plus the failure reason
 * {@link TurnRef.error} carries.
 *
 * @remarks `@clarvis/protocol`'s `SessionTurn` declares no `error` slot, which
 *   is precisely why {@link metaToSession} used to drop the reason a run failed
 *   on the way to disk. Nothing validates a turn's members on the way back —
 *   the kernel's session service checks a session's identity and that `turns` is
 *   an array, there is no schema for the document, and the transport carries it
 *   opaquely — so the member survives the round trip intact. Declaring the
 *   widening here keeps that honest instead of hiding it in a cast at each use,
 *   and it disappears the day the wire type gains the slot.
 */
type PersistedSessionTurn = Session["turns"][number] & {
  error?: { code: string; message: string };
};

/**
 * Read a persisted turn's failure reason, ignoring anything that is not the
 * `{code, message}` pair {@link redactTurnError} writes.
 *
 * @param turn - a turn as it came back from the session document.
 * @returns the reason, or `undefined` when the turn carries none or carries
 *   something else — a document on disk is the one input here that no type
 *   describes, so a corrupt or foreign one degrades to "no reason recorded"
 *   rather than to a `TurnRef` whose `error` is not an error.
 */
function persistedTurnError(
  turn: Session["turns"][number],
): { code: string; message: string } | undefined {
  const error = (turn as PersistedSessionTurn).error;
  return typeof error?.code === "string" && typeof error.message === "string"
    ? { code: error.code, message: error.message }
    : undefined;
}

/** Adapt the UI's {@link SessionMeta} to the protocol's wire {@link Session} shape. */
export function metaToSession(m: SessionMeta): Session {
  if (m.projectId === undefined) throw new Error("session project identity is required");
  return {
    id: m.id,
    title: m.title,
    project_id: m.projectId,
    workspace: m.workspace,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    ...(m.profile !== undefined ? { profile: m.profile } : {}),
    turns: m.turns.map((t): PersistedSessionTurn => ({
      user_preview: t.userPreview,
      ...(t.executionId !== undefined ? { execution_id: t.executionId } : {}),
      status: t.status,
      ...(t.startedAt !== undefined ? { started_at: t.startedAt } : {}),
      ...(t.endedAt !== undefined ? { ended_at: t.endedAt } : {}),
      ...(t.error !== undefined ? { error: { code: t.error.code, message: t.error.message } } : {}),
    })),
    totals: {
      input: m.totals.input,
      output: m.totals.output,
      cached: m.totals.cached,
      ...(m.totals.costUsd !== undefined ? { cost_usd: m.totals.costUsd } : {}),
    },
    ...(m.pending !== undefined ? { pending: m.pending } : {}),
  };
}

/** Adapt a protocol wire {@link Session} back into the UI's {@link SessionMeta}, tagged with `owner`. */
export function sessionToMeta(s: Session, owner: string): SessionMeta {
  return {
    id: s.id,
    title: s.title,
    projectId: s.project_id,
    workspace: s.workspace,
    owner,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    ...(s.profile !== undefined ? { profile: s.profile } : {}),
    turns: s.turns.map((t): TurnRef => {
      const error = persistedTurnError(t);
      return {
        userPreview: t.user_preview,
        ...(t.execution_id !== undefined ? { executionId: t.execution_id } : {}),
        status: t.status,
        ...(t.started_at !== undefined ? { startedAt: t.started_at } : {}),
        ...(t.ended_at !== undefined ? { endedAt: t.ended_at } : {}),
        ...(error !== undefined ? { error } : {}),
      };
    }),
    totals: {
      input: s.totals.input,
      output: s.totals.output,
      cached: s.totals.cached,
      ...(s.totals.cost_usd !== undefined ? { costUsd: s.totals.cost_usd } : {}),
    },
    ...(s.pending !== undefined ? { pending: s.pending } : {}),
  };
}

/** Adapt the bounded catalog projection without pretending its turns are loaded. */
function sessionSummaryToMeta(s: SessionSummary, owner: string): SessionMeta {
  return {
    id: s.id,
    title: s.title,
    projectId: s.project_id,
    workspace: s.workspace,
    owner,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    ...(s.profile !== undefined ? { profile: s.profile } : {}),
    turns: [],
    turnCount: s.turn_count,
    totals: {
      input: s.totals.input,
      output: s.totals.output,
      cached: s.totals.cached,
      ...(s.totals.cost_usd !== undefined ? { costUsd: s.totals.cost_usd } : {}),
    },
  };
}

/** Visible turn count for both full documents and catalog-only summaries. */
export function sessionTurnCount(meta: SessionMeta): number {
  return meta.turnCount ?? meta.turns.length;
}

/** Seed the store from one bounded summary page; full documents load on demand. */
export async function loadSessions(
  sessions: SessionService,
  owner: string,
): Promise<SessionMeta[]> {
  const page = await sessions.listPage({ limit: 200 });
  return page.items.map((s) => sessionSummaryToMeta(s, owner));
}

/**
 * Build a {@link SessionStore} over a kernel {@link SessionService}: reads are
 * served from an in-memory cache seeded by `initial`, while writes/deletes are
 * applied optimistically to the cache and queued per-session against the
 * backing service (see {@link SessionStore.flushPending}).
 */
export function createSessionStore(
  sessions: SessionService,
  owner: string,
  initial: SessionMeta[] = [],
  opts: { onError?: (message: string) => void } = {},
): SessionStore {
  const cache = new Map<SessionId, SessionMeta>(initial.map((m) => [m.id, m]));
  type PendingMutation = { kind: "save"; snapshot: Session } | { kind: "delete" };
  interface WriteLane {
    /** Only the newest mutation that has not started physically is retained. */
    pending: PendingMutation | undefined;
    promise: Promise<void>;
  }
  const lanes = new Map<SessionId, WriteLane>();
  const fullSessionLru: SessionId[] = [];

  function forgetFull(id: SessionId): void {
    const at = fullSessionLru.indexOf(id);
    if (at !== -1) fullSessionLru.splice(at, 1);
  }

  /**
   * Keep only a small LRU of complete turn indexes. Catalog summaries remain
   * resident, so the session picker keeps its identity/totals without retaining
   * every opened transcript forever.
   */
  function touchFull(id: SessionId): void {
    forgetFull(id);
    fullSessionLru.push(id);
    demoteOldFullSessions();
  }

  function demoteOldFullSessions(): void {
    let candidates = fullSessionLru.length;
    while (fullSessionLru.length > MAX_RESIDENT_FULL_SESSIONS && candidates-- > 0) {
      const victim = fullSessionLru.shift();
      if (victim === undefined) break;
      if (lanes.has(victim)) {
        fullSessionLru.push(victim);
        continue;
      }
      const current = cache.get(victim);
      if (current === undefined || current.turnCount !== undefined) continue;
      const { pending: _pending, ...summary } = current;
      cache.set(victim, {
        ...summary,
        turns: [],
        turnCount: current.turns.length,
      });
    }
  }

  for (const entry of initial) {
    if (entry.turnCount === undefined) touchFull(entry.id);
  }

  async function persist(id: SessionId, mutation: PendingMutation): Promise<void> {
    if (mutation.kind === "save") await sessions.save(mutation.snapshot);
    else await sessions.delete(id);
  }

  /**
   * Run one physical mutation per id at a time and retain only the latest
   * not-yet-started state. Session updates are snapshots of an ever-growing
   * turn list; chaining every intermediate snapshot made a blocked writer hold
   * 1 + 2 + ... + N turns (quadratic memory). Last-write-wins coalescing keeps
   * at most the in-flight snapshot plus one replacement.
   */
  function enqueue(id: SessionId, mutation: PendingMutation): void {
    const current = lanes.get(id);
    if (current !== undefined) {
      current.pending = mutation;
      return;
    }

    const lane: WriteLane = { pending: mutation, promise: Promise.resolve() };
    lanes.set(id, lane);
    lane.promise = (async () => {
      try {
        while (lane.pending !== undefined) {
          const next = lane.pending;
          lane.pending = undefined;
          try {
            await persist(id, next);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            opts.onError?.(`session ${next.kind} failed: ${message}`);
          }
        }
      } finally {
        // Remove the lane in the same async continuation that observed an empty
        // queue. A chained `.finally()` leaves one microtask-sized gap: a save
        // can find the old lane there, populate `pending`, and then have that
        // lane deleted without another drain ever seeing the mutation.
        if (lanes.get(id) === lane) {
          lanes.delete(id);
          demoteOldFullSessions();
        }
      }
    })();
  }

  return {
    list: () => [...cache.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    get: (id) => cache.get(id) ?? null,
    load: async (id) => {
      const current = cache.get(id);
      if (current !== undefined && current.turnCount === undefined) {
        touchFull(id);
        return current;
      }
      const loaded = await sessions.get(id);
      if (loaded === null) {
        cache.delete(id);
        forgetFull(id);
        return null;
      }
      const meta = sessionToMeta(loaded, owner);
      cache.set(id, meta);
      touchFull(id);
      return meta;
    },
    save: (meta) => {
      cache.set(meta.id, meta);
      touchFull(meta.id);
      const snapshot = metaToSession(meta);
      enqueue(meta.id, { kind: "save", snapshot });
    },
    delete: (id) => {
      const had = cache.delete(id);
      forgetFull(id);
      enqueue(id, { kind: "delete" });
      return had;
    },
    memory: () => ({
      cached_sessions: cache.size,
      full_sessions: fullSessionLru.length,
      pending_session_write_lanes: lanes.size,
      queued_session_writes: [...lanes.values()].filter((lane) => lane.pending !== undefined)
        .length,
    }),
    flushPending: async () => {
      while (lanes.size > 0) await Promise.all([...lanes.values()].map((lane) => lane.promise));
      demoteOldFullSessions();
    },
  };
}
