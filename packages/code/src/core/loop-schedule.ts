import { Cron } from "croner";

/** A conversation's recurrence, with elapsed intervals kept distinct from calendar schedules. */
export type LoopSchedule =
  | { readonly kind: "interval"; readonly everyMs: number; readonly basis: "after-completion" }
  | { readonly kind: "cron"; readonly expression: string; readonly timezone: string };

/** Clocks and cancellable wakeups owned by one live TUI, injectable without a model or filesystem. */
export interface LoopClock {
  now(): number;
  elapsed(): number;
  wake(callback: () => void, delayMs: number): () => void;
}

/** Production timers never keep an otherwise closed TUI process alive. */
export const systemLoopClock: LoopClock = {
  now: () => Date.now(),
  elapsed: () => performance.now(),
  wake: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** Frozen execution identity; the fingerprint contains no configuration values or credentials. */
export interface LoopBinding {
  readonly sessionId: string;
  readonly generation: number;
  readonly owner: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly configFingerprint: string;
  readonly configLabel: string;
}

/** Measured aggregate usage. Missing cost or tokens remain unknown, including after later success. */
export interface LoopUsage {
  input?: number;
  output?: number;
  costUsd?: number;
}

/** A terminal receipt is published only after reconciliation and physical handle settlement. */
export interface LoopTurnCompletion {
  readonly status: "completed" | "failed" | "cancelled" | "unknown";
  readonly reason?: string;
  readonly usage: LoopUsage;
}

/** One reserved occurrence; validity is rechecked after asynchronous preparation. */
export interface ScheduledTurnRequest {
  readonly binding: LoopBinding;
  readonly prompt: string;
  readonly occurrenceId: string;
  readonly valid: () => boolean;
}

/** Admission reserves synchronously. A cancellation acknowledgement never releases completion. */
export type ScheduledTurnAdmission =
  | {
      readonly status: "admitted";
      readonly executionId: string;
      readonly completion: Promise<LoopTurnCompletion>;
      cancel(): Promise<void>;
    }
  | { readonly status: "deferred" | "refused"; readonly reason: string };

/** Compares complete authority bindings, including a reopened conversation's new generation. */
export function sameLoopBinding(left: LoopBinding, right: LoopBinding | null): boolean {
  return (
    right !== null &&
    left.sessionId === right.sessionId &&
    left.generation === right.generation &&
    left.owner === right.owner &&
    left.workspaceId === right.workspaceId &&
    left.agentId === right.agentId &&
    left.configFingerprint === right.configFingerprint
  );
}

const FIELD_LIMITS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;
const MINUTE = 60_000;
const MAX_DATE = 8_640_000_000_000_000;

function fieldValues(field: string, minimum: number, maximum: number): Set<number> {
  const values = new Set<number>();
  for (const entry of field.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(entry);
    if (!match) throw new Error("Cron accepts only numeric fields, *, lists, ranges and steps.");
    const step = match[2] === undefined ? 1 : Number(match[2]);
    const bounds = match[1] === "*" ? [minimum, maximum] : match[1]!.split("-").map(Number);
    const start = bounds[0]!;
    const end = bounds[1] ?? (match[2] === undefined ? start : maximum);
    if (
      !Number.isSafeInteger(step) ||
      step < 1 ||
      step > maximum - minimum + 1 ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < minimum ||
      end > maximum ||
      start > end
    )
      throw new Error(
        `Cron field values must be within ${minimum}..${maximum}, with a positive step.`,
      );
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

/** Resolve and retain one explicit IANA timezone, rejecting offset strings and unknown names. */
export function loopTimezone(value?: string): string {
  const timezone = value ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timezone || /^[+-]/u.test(timezone))
    throw new Error("Use an IANA timezone, such as America/Recife.");
  try {
    return new Intl.DateTimeFormat("en", { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`Unknown timezone: ${timezone}`);
  }
}

/** Parse an integer duration without converting it to cron or losing a 90-minute interval. */
export function loopInterval(value: string): LoopSchedule & { kind: "interval" } {
  const match = /^([1-9]\d*)([mhd])$/u.exec(value);
  if (!match) throw new Error("Use a positive integer duration in m, h or d (minimum 1m).");
  const everyMs = Number(match[1]) * { m: MINUTE, h: 60 * MINUTE, d: 1440 * MINUTE }[match[2]!]!;
  if (!Number.isSafeInteger(everyMs) || everyMs > MAX_DATE - Date.now())
    throw new Error("Interval is too large.");
  return { kind: "interval", everyMs, basis: "after-completion" };
}

/** Calendar queries never install a Croner callback or retain a library-owned timer. */
export interface LoopCalendar {
  next(after: number): number | null;
  latest(at: number): number | null;
}

/**
 * Constrain Croner's wider dialect and reject normalized DST-gap dates before they become eligible.
 * Calendar iteration remains in the library; this adapter verifies its local wall-clock result.
 */
export function createLoopCalendar(expression: string, timezone: string): LoopCalendar {
  if (expression.length > 256) throw new Error("Cron expression is too long.");
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5)
    throw new Error("Cron requires exactly five fields: minute hour day month weekday.");
  const values = fields.map((field, index) => {
    const [minimum, maximum] = FIELD_LIMITS[index]!;
    return fieldValues(field, minimum, maximum);
  });
  if (values[4]!.has(7)) values[4]!.add(0);
  const zone = loopTimezone(timezone);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });
  const pattern = fields
    .map((field, index) => (field === "*" ? field : [...values[index]!].join(",")))
    .join(" ");
  const cron = new Cron(pattern, {
    timezone: zone,
    mode: "5-part",
    paused: true,
    domAndDow: false,
  });
  const localEpoch = (at: number): number => {
    const parts = Object.fromEntries(
      formatter.formatToParts(at).map((part) => [part.type, Number(part.value)]),
    );
    return Date.UTC(parts.year!, parts.month! - 1, parts.day, parts.hour, parts.minute);
  };
  const firstOccurrence = (at: number): number => {
    const local = localEpoch(at);
    let first = at;
    for (const sample of [at - 2 * 1440 * MINUTE, at + 2 * 1440 * MINUTE]) {
      const offset = localEpoch(sample) - sample;
      const candidate = local - offset;
      if (candidate < first && localEpoch(candidate) === local) first = candidate;
    }
    return first;
  };
  const matches = (at: number): boolean => {
    const parts = Object.fromEntries(
      formatter.formatToParts(at).map((part) => [part.type, Number(part.value)]),
    );
    const weekday = new Date(Date.UTC(parts.year!, parts.month! - 1, parts.day)).getUTCDay();
    const day = values[2]!.has(parts.day!);
    const week = values[4]!.has(weekday);
    const dateMatches = fields[2] === "*" ? week : fields[4] === "*" ? day : day || week;
    return (
      values[0]!.has(parts.minute!) &&
      values[1]!.has(parts.hour!) &&
      values[3]!.has(parts.month!) &&
      dateMatches
    );
  };
  const find = (at: number, forward: boolean): number | null => {
    if (!Number.isFinite(at) || Math.abs(at) >= MAX_DATE) return null;
    for (let count = 1; count <= 2048; count *= 2) {
      const dates = forward
        ? cron.nextRuns(count, new Date(at))
        : cron.previousRuns(count, new Date(at));
      for (const date of dates) {
        const candidate = firstOccurrence(date.getTime());
        if (
          Number.isFinite(candidate) &&
          (forward ? candidate > at : candidate < at) &&
          matches(candidate)
        )
          return candidate;
      }
      if (dates.length < count) return null;
    }
    throw new Error("Cron calendar could not resolve a valid occurrence.");
  };
  return {
    next: (after) => find(after, true),
    latest: (at) => find(Math.floor(at / MINUTE) * MINUTE + 1000, false),
  };
}

/** A concise user-facing explanation of the two distinct timing contracts. */
export function loopScheduleLabel(schedule: LoopSchedule): string {
  if (schedule.kind === "cron") return `cron ${schedule.expression} (${schedule.timezone})`;
  const minutes = schedule.everyMs / MINUTE;
  return `${minutes} minute${minutes === 1 ? "" : "s"} after each execution`;
}
