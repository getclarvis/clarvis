/**
 * SessionService — a client's session index.
 *
 * Groups runs into a conversation together with the display and accounting state a
 * UI keeps. Persisted server-side so a session can follow the user on a hosted
 * kernel, scoped to the connection's workspace (no owner on the surface — the
 * kernel derives it).
 *
 * A {@link Session} is the UI model lifted into the contract: the kernel stores and
 * lists it, but the run transcript itself lives in the runs service (a turn points
 * at an `execution_id`).
 */

import type { CursorPage, CursorPagination, Timestamp } from "./common.ts";
import type { Message } from "./runs.ts";
import type { EnvironmentRunRef } from "./environments.ts";

/** Lifecycle status of one turn in a session. */
export type SessionTurnStatus =
  "pending" | "running" | "done" | "error" | "cancelled" | "interrupted";

/** Aggregate token / cost totals for a session, summed across its runs. */
export interface SessionTotals {
  /** Total input (prompt) tokens. */
  input: number;
  /** Total output (completion) tokens. */
  output: number;
  /** Total tokens served from the provider's prompt cache. */
  cached: number;
  /** Estimated spend in US dollars, when pricing is known. */
  cost_usd?: number;
}

/** One user turn and the run it drove, if any. */
export interface SessionTurn {
  /** Redacted first-line preview of the user's message. */
  user_preview: string;
  /**
   * The run this turn drove, if it started one - an id into the runs service,
   * where the transcript lives. Absent for a turn that produced no run.
   */
  execution_id?: string;
  /** Extension Environment snapshot under which this turn started. */
  environment?: EnvironmentRunRef;
  status: SessionTurnStatus;
  /** Epoch-ms start; absent until the turn begins. See {@link Timestamp}. */
  started_at?: Timestamp;
  /** Epoch-ms end; absent while the turn is unfinished. See {@link Timestamp}. */
  ended_at?: Timestamp;
}

/**
 * A conversation binding turns to runs plus UI display state.
 *
 * Transcript content remains on `RunService`; this record is the index.
 */
export interface Session {
  id: string;
  title: string;
  /** Project this conversation belongs to. */
  project_id: string;
  /** Workspace this session is scoped to (the connection's workspace). */
  workspace: string;
  /** Epoch-ms creation time. See {@link Timestamp}. */
  created_at: Timestamp;
  /** Epoch-ms last-activity time; sessions list newest-updated first. */
  updated_at: Timestamp;
  /** Id of the agent profile the session runs under, when pinned. */
  profile?: string;
  /** The conversation's turns in order; each may point at a run. */
  turns: SessionTurn[];
  totals: SessionTotals;
  /**
   * Observations (local shell output, skill digests) appended after the last run
   * and not yet delivered to one — persisted so quit/resume does not drop them.
   */
  pending?: Message[];
}

/** Bounded catalog projection that never carries turns or pending messages. */
export interface SessionSummary {
  id: string;
  title: string;
  project_id: string;
  workspace: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  profile?: string;
  turn_count: number;
  last_status?: SessionTurnStatus;
  /** Environment stamped on the newest turn, when known. */
  last_environment?: EnvironmentRunRef;
  totals: SessionTotals;
}

/** CRUD over workspace-scoped sessions. */
export interface SessionService {
  /** This workspace's bounded summary page, newest-updated first. */
  listPage(page?: CursorPagination): Promise<CursorPage<SessionSummary>>;

  /** This workspace's sessions, newest-updated first. */
  list(): Promise<Session[]>;

  /**
   * Fetch one session by id.
   *
   * @param id - Session id.
   * @returns The session, or `null` when missing.
   */
  get(id: string): Promise<Session | null>;

  /**
   * Create or overwrite a session record.
   *
   * @param session - Full session document to persist.
   */
  save(session: Session): Promise<void>;

  /**
   * Delete a session by id.
   *
   * @param id - Session id.
   * @returns `true` if a record was removed.
   */
  delete(id: string): Promise<boolean>;
}
