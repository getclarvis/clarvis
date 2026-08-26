import { sanitizeErrorMessage } from "./sanitize.ts";

export interface TaskFailure {
  operation: string;
  cause: string;
  workspace?: string;
}

export interface TaskObservation {
  operation: string;
  workspace?: string;
  logger?: { warn(fields: object, message: string): void };
  observer?: (failure: TaskFailure) => void;
  dedupeKey?: string;
  rateLimitMs?: number;
  clock?: () => number;
}

const DEFAULT_RATE_LIMIT_MS = 60_000;
const MAX_DEDUPE_KEYS = 1_024;
const lastEmission = new Map<string, number>();

function observe(error: unknown, options: TaskObservation): void {
  const now = options.clock?.() ?? Date.now();
  const key = options.dedupeKey ?? `${options.operation}\0${options.workspace ?? ""}`;
  const rateLimitMs = options.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
  const previous = lastEmission.get(key);
  if (previous !== undefined && now - previous < rateLimitMs) return;
  if (lastEmission.size >= MAX_DEDUPE_KEYS && !lastEmission.has(key)) {
    const oldest = lastEmission.keys().next().value;
    if (oldest !== undefined) lastEmission.delete(oldest);
  }
  lastEmission.delete(key);
  lastEmission.set(key, now);
  const failure: TaskFailure = {
    operation: options.operation,
    cause: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
  };
  try {
    options.observer?.(failure);
  } catch {}
  try {
    options.logger?.warn(failure, "best_effort_failed");
  } catch {}
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
