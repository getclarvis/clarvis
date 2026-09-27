import { sanitizeErrorMessage } from "./sanitize.ts";

export interface TaskFailure {
  operation: string;
  cause: string;
  workspace?: string;
}

export interface TaskObservation {
  /** History owned by the store, connection, session or host scheduling this task. */
  scope: TaskObservationScope;
  operation: string;
  workspace?: string;
  logger?: { warn(fields: object, message: string): void };
  observer?: (failure: TaskFailure) => void;
  dedupeKey?: string;
  rateLimitMs?: number;
}

const DEFAULT_RATE_LIMIT_MS = 60_000;
const MAX_DEDUPE_KEYS = 1_024;

/** One owner's bounded failure-observation history. Share it only deliberately. */
export interface TaskObservationScope {
  /** Admit one failure according to this scope's rate limit. */
  observe(error: unknown, options: Omit<TaskObservation, "scope">): void;
}

/**
 * Create an independent, 1,024-key failure history for one owner.
 *
 * @param options - optional clock shared by all observations in this scope.
 * @returns a scope whose repeated failures suppress both observer and logger
 * notifications until each observation's rate-limit window expires.
 */
export function createTaskObservationScope(
  options: { clock?: () => number } = {},
): TaskObservationScope {
  const lastEmission = new Map<string, number>();
  const clock = options.clock ?? Date.now;
  return {
    observe(error, observation) {
      const now = clock();
      const key =
        observation.dedupeKey ?? `${observation.operation}\0${observation.workspace ?? ""}`;
      const rateLimitMs = observation.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
      const previous = lastEmission.get(key);
      if (previous !== undefined && now - previous < rateLimitMs) return;
      if (lastEmission.size >= MAX_DEDUPE_KEYS && !lastEmission.has(key)) {
        const oldest = lastEmission.keys().next().value;
        if (oldest !== undefined) lastEmission.delete(oldest);
      }
      lastEmission.delete(key);
      lastEmission.set(key, now);
      const failure: TaskFailure = {
        operation: observation.operation,
        cause: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
        ...(observation.workspace !== undefined ? { workspace: observation.workspace } : {}),
      };
      try {
        observation.observer?.(failure);
      } catch {}
      try {
        observation.logger?.warn(failure, "best_effort_failed");
      } catch {}
    },
  };
}

function observe(error: unknown, options: TaskObservation): void {
  options.scope.observe(error, options);
}

/** Run operational work that may fail without rejecting its caller. */
export async function bestEffort(run: () => unknown, options: TaskObservation): Promise<void> {
  try {
    await run();
  } catch (error) {
    observe(error, options);
  }
}

/** Detach background work while retaining an observable failure path. */
export function detachObserved(run: () => unknown, options: TaskObservation): void {
  void bestEffort(run, options);
}

/** Consume a derived rejection whose failure is observed by a named primary channel. */
export function suppressSecondaryRejection(
  promise: PromiseLike<unknown>,
  observedBy: string,
): void {
  if (observedBy.trim().length === 0) {
    throw new Error("suppressSecondaryRejection requires the primary observation channel");
  }
  void Promise.resolve(promise).catch(() => {});
}
