import type { Logger } from "./ports.ts";

/**
 * Every level a Clarvis logger emits at, ascending in severity, plus the one
 * that emits nothing.
 *
 * @remarks A tuple rather than an array so `CLARVIS_LOG_LEVEL`'s schema can be
 * derived from it instead of spelling the members a second time. The two used
 * to disagree: the env enum admitted `trace` and `fatal`, which {@link Logger}
 * has no method for. See `specs/cross-cutting/observability.md` §2.6.
 */
export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;

/** One of {@link LOG_LEVELS}. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** The level a logger emits at when nothing selects one. */
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
};

/**
 * Narrow an arbitrary string to a {@link LogLevel}.
 *
 * @param value - the candidate, typically from the environment.
 * @returns whether `value` names a level this port can emit at.
 */
export function isLogLevel(value: string): value is LogLevel {
  return Object.hasOwn(LEVEL_RANK, value);
}

/**
 * A {@link Logger} that discards everything, for a package whose host supplied
 * none.
 *
 * @remarks The reason a package writes `logger: Logger = NOOP_LOGGER` rather
 * than `logger?: Logger`: an optional-chained call is an extra branch at every
 * call site, and `@clarvis/capability` and `@clarvis/paths` hold 1.00/1.00
 * coverage floors. Absent a logger the behaviour is byte-identical either way,
 * so the branch buys nothing and costs a test.
 */
export const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
  level: "silent",
};

/**
 * Whether a record at `level` would survive `logger`'s own level.
 *
 * @param logger - the logger about to be called.
 * @param level - the level of the record being considered.
 * @returns `false` only when the logger reports a level that discards it.
 * @remarks Guards the *construction* of a payload, which a backend's own level
 *   check cannot: the bindings object is built by the caller before any backend
 *   is reached. Use it on a site that repeats within a run; a once-per-run site
 *   should just log.
 *
 *   A logger that reports no level, or one this port does not recognize, is
 *   treated as emitting — a diagnostic lost to an unparsable level is worse
 *   than one written needlessly.
 */
export function levelEnabled(logger: Logger, level: Exclude<LogLevel, "silent">): boolean {
  const active = logger.level;
  if (active === undefined || !isLogLevel(active)) return true;
  return LEVEL_RANK[level] >= LEVEL_RANK[active];
}

/**
 * Derive a logger carrying `bindings`, or return `logger` unchanged.
 *
 * @param logger - the logger to derive from.
 * @param bindings - fields every record from the result should carry.
 * @returns the derived logger, or `logger` when it implements no `child`.
 * @remarks The fallback is load-bearing, not defensive: a host may supply a
 *   plain four-method sink, and correlation degrading to "absent" is correct
 *   where refusing to log would not be.
 */
export function bind(logger: Logger, bindings: Record<string, unknown>): Logger {
  return logger.child?.(bindings) ?? logger;
}

/**
 * Parse a `CLARVIS_LOG`-style per-component level specification.
 *
 * @param spec - a comma-separated list of `component=level`, e.g.
 *   `paths.lease=debug,mcp=debug,llm=warn`. Whitespace around either side is
 *   ignored; an entry naming no recognized level is skipped.
 * @returns the parsed components, in no particular order.
 * @remarks The component vocabulary is deliberately **open**, like `TraceKind`,
 *   so a capability outside the engine can name its own subsystem without the
 *   engine declaring it. The cost of that openness is that a misspelled
 *   component is a silent no-op rather than an error.
 */
export function parseLogScopes(spec: string | undefined): ReadonlyMap<string, LogLevel> {
  const scopes = new Map<string, LogLevel>();
  if (spec === undefined) return scopes;
  for (const entry of spec.split(",")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    const component = entry.slice(0, separator).trim();
    const level = entry.slice(separator + 1).trim();
    if (component.length === 0 || !isLogLevel(level)) continue;
    scopes.set(component, level);
  }
  return scopes;
}

/**
 * The level a logger is already emitting at, when it reports a usable one.
 *
 * @param logger - the host's root logger.
 * @returns its level, or `undefined` when it reports none this port recognizes.
 * @remarks This is the right fallback for a per-component child, and the
 *   configured `CLARVIS_LOG_LEVEL` is not. A host may supply a logger it
 *   configured itself — `@clarvis/code` opens its diagnostic session at the
 *   level `--debug` asked for — and pinning that host's component children to an
 *   environment variable it never set makes `--debug` quietly capture less than
 *   the session it just opened. Where the host's logger *is* built from
 *   `CLARVIS_LOG_LEVEL`, the two agree and nothing changes.
 */
export function activeLevelOf(logger: Logger): LogLevel | undefined {
  const active = logger.level;
  return active !== undefined && isLogLevel(active) ? active : undefined;
}

/**
 * Resolve the level that applies to one component.
 *
 * @param scopes - the parsed output of {@link parseLogScopes}.
 * @param component - the component the record belongs to, e.g. `paths.lease`.
 * @param fallback - the level to use when no scope matches.
 * @returns the most specific matching scope's level, else `fallback`.
 * @remarks Matching is longest-prefix on dot boundaries, so `mcp=debug` covers
 *   `mcp.connect` while `mcp.connect=warn` still overrides it.
 */
export function levelFor(
  scopes: ReadonlyMap<string, LogLevel>,
  component: string,
  fallback: LogLevel,
): LogLevel {
  if (scopes.size === 0) return fallback;
  let candidate = component;
  for (;;) {
    const level = scopes.get(candidate);
    if (level !== undefined) return level;
    const boundary = candidate.lastIndexOf(".");
    if (boundary < 0) return fallback;
    candidate = candidate.slice(0, boundary);
  }
}

/**
 * A backend whose `child` also accepts a per-child level.
 *
 * @remarks {@link Logger.child} takes bindings only, deliberately — a level
 * belongs to the backend, not the contract. pino's takes a second options
 * argument, and passing one to an implementation that declares a single
 * parameter is harmless: the extra argument is ignored and the component still
 * gets its bindings, which is the correct degradation.
 */
interface LevelledLogger {
  child(bindings: Record<string, unknown>, options?: { level?: string }): Logger;
}

/**
 * Derive the logger one subsystem writes through.
 *
 * @param logger - the logger to derive from.
 * @param component - the subsystem name, stamped as `component` and matched
 *   against `CLARVIS_LOG` by {@link levelFor}.
 * @param level - the level to request of the derived logger; omit to inherit.
 * @returns the derived logger, or `logger` unchanged when it implements no
 *   `child`.
 * @remarks Lives here rather than in a host because two layers need it and
 *   neither can import the other: `@clarvis/kernel` derives a component logger
 *   for each collaborator it constructs, and `@clarvis/loop` does the same for
 *   the three subsystems it wires directly. Before this was shared, the loop
 *   reached for {@link bind}, which carries the binding but **not** the level —
 *   so `component` was stamped on `paths` and `trace` records while
 *   `CLARVIS_LOG=paths=debug` silently did nothing to them.
 *
 *   The double assertion is load-bearing rather than lazy. TypeScript checks
 *   method parameters bivariantly, so it considers the port's one-parameter
 *   `child` already assignable to {@link LevelledLogger} and collapses a single
 *   assertion to a no-op — while still rejecting the two-argument call.
 */
export function componentLogger(logger: Logger, component: string, level?: LogLevel): Logger {
  return bindLevelled(logger, { component }, level);
}

/**
 * Derive a logger carrying `bindings` and, where the backend supports it, its
 * own level.
 *
 * @param logger - the logger to derive from.
 * @param bindings - fields every record from the result should carry.
 * @param level - the level to request of the derived logger; omit to inherit.
 * @returns the derived logger, or `logger` unchanged when it implements no
 *   `child`.
 * @remarks The general form behind {@link componentLogger}. It exists separately
 *   because the audit channel needs more than a component name — it pins a level
 *   *and* stamps `audit: true` — and duplicating the assertion below in a host
 *   is how two copies drift.
 */
export function bindLevelled(
  logger: Logger,
  bindings: Record<string, unknown>,
  level?: LogLevel,
): Logger {
  if (logger.child === undefined) return logger;
  return level === undefined
    ? logger.child(bindings)
    : (logger as unknown as LevelledLogger).child(bindings, { level });
}

/** Decides whether one occurrence of a repeating event should be emitted. */
export type Sampler = (key: string) => boolean;

const DEFAULT_MAX_KEYS = 1_024;

function evictOldest(seen: Map<string, unknown>, key: string, maxKeys: number): void {
  if (seen.size < maxKeys || seen.has(key)) return;
  const oldest = seen.keys().next().value;
  if (oldest !== undefined) seen.delete(oldest);
}

/**
 * Create a sampler that admits the first eight occurrences of a key and then
 * every power of two.
 *
 * @param maxKeys - how many distinct keys to track before evicting the oldest.
 * @returns a {@link Sampler}; each call counts the occurrence it judges.
 * @remarks This is the repository's existing policy, not a new one — it is what
 *   `@clarvis/code`'s diagnostic counters already use. A runaway loop stays
 *   visible without becoming the leak it is reporting.
 *
 *   Deliberately an instance rather than a module singleton: two packages
 *   sharing one counter would sample each other's events.
 */
export function createSampler(maxKeys: number = DEFAULT_MAX_KEYS): Sampler {
  const counts = new Map<string, number>();
  return (key: string): boolean => {
    evictOldest(counts, key, maxKeys);
    const next = (counts.get(key) ?? 0) + 1;
    counts.delete(key);
    counts.set(key, next);
    if (next <= 8) return true;
    return (next & (next - 1)) === 0;
  };
}

/** Options for {@link createRateLimiter}. */
export interface RateLimiterOptions {
  /** Minimum gap between two admitted occurrences of one key. */
  windowMs?: number;
  /** How many distinct keys to track before evicting the oldest. */
  maxKeys?: number;
  /** Clock source, for tests. */
  clock?: () => number;
}

const DEFAULT_RATE_LIMIT_MS = 60_000;

/**
 * Create a rate limiter admitting one occurrence of a key per window.
 *
 * @param options - see {@link RateLimiterOptions}.
 * @returns a predicate that admits and records an occurrence.
 * @remarks For a steady-state misconfiguration, where the fact is worth saying
 *   once and worthless said continuously. The key must carry the distinguishing
 *   identity: a key of `operation` alone collapses two different servers
 *   failing the same way into one line naming neither.
 */
export function createRateLimiter(options: RateLimiterOptions = {}): Sampler {
  const windowMs = options.windowMs ?? DEFAULT_RATE_LIMIT_MS;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const clock = options.clock ?? Date.now;
  const emitted = new Map<string, number>();
  return (key: string): boolean => {
    const now = clock();
    const previous = emitted.get(key);
    if (previous !== undefined && now - previous < windowMs) return false;
    evictOldest(emitted, key, maxKeys);
    emitted.delete(key);
    emitted.set(key, now);
    return true;
  };
}
