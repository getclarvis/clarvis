/**
 * The vocabulary a hook runner and its host agree on.
 *
 * @remarks
 * Every type here is structural on purpose. `@clarvis/loop` already owns the
 * validated configuration shape (`HookConfig`, inferred from its zod schema) and
 * the loop-facing verdict (`HookVerdict`); this package must not import either,
 * because the loop depends on it and the reverse edge would close a cycle.
 * {@link HookSpec} is therefore written so that a `HookConfig` is assignable to
 * it without a cast, and the loop adapts {@link HookOutcome} to its own verdict.
 */

/**
 * Filter narrowing a tool-scoped hook to a subset of tool calls.
 *
 * @remarks
 * A scoping device, not a security boundary — the command guard is what enforces
 * policy. See {@link matchesCandidate} for the exact evaluation rules.
 */
export interface HookMatch {
  /**
   * Tool name pattern(s): an exact name, or a glob whose only wildcard is `*`.
   * An array matches when any pattern matches.
   */
  readonly tool?: string | readonly string[] | undefined;
  /**
   * Map of argument field name to a JS regular expression tested against that
   * argument's value. Every entry must match.
   */
  readonly args?: Readonly<Record<string, string>> | undefined;
}

/**
 * One workspace hook as configured.
 *
 * @remarks
 * Structurally compatible with `@clarvis/loop`'s `HookConfig`. The runner treats
 * `event` as an opaque string: which events exist, which of them are gates, and
 * which accept a `match` are all decided by the loop's schema, and duplicating
 * that list here would only create something to drift.
 */
export interface HookSpec {
  readonly event: string;
  readonly command: string;
  readonly match?: HookMatch | undefined;
  readonly timeout_ms?: number | undefined;
  readonly on_failure?: "pass" | "deny" | undefined;
}

/** The tool call a tool-scoped hook's {@link HookMatch} is evaluated against. */
export interface ToolCandidate {
  readonly tool: string;
  /** Stable alternate identities, such as an MCP tool's dotted full name. */
  readonly aliases?: readonly string[] | undefined;
  readonly arguments: unknown;
}

/** One fire point, as the host describes it to the runner. */
export interface HookInvocation {
  /** Selects which specs fire; matched against {@link HookSpec.event}. */
  readonly event: string;
  /** JSON-serializable payload placed on the child's stdin under `data`. */
  readonly data: unknown;
  /** Present only for tool-scoped events; absent means `match` cannot apply. */
  readonly candidate?: ToolCandidate | undefined;
  /**
   * Timeout for a spec that declares none. Always supplied by the caller: the
   * runner has no opinion about which events deserve which budget, because that
   * depends on how often the host fires them.
   */
  readonly defaultTimeoutMs: number;
  /**
   * Whether this fire point's verdict can block. `on_failure: "deny"` is honored
   * only when true; an observer event always passes.
   *
   * @remarks "Always passes" covers a hook that *succeeded* and asked to deny,
   *   not only one that failed — a `{"kind":"deny"}` outcome at an observer
   *   event is downgraded to `pass` just as a failure is. Non-blocking outcomes
   *   (`context`, `advise`) are still delivered, since the point of an observer
   *   event is to hear them.
   */
  readonly gate: boolean;
  /**
   * Whether this fire point has arguments a hook may replace.
   *
   * @remarks True only where the host will actually act on new arguments, which
   *   is the pending-tool-call event alone. Elsewhere a hook that asks for a
   *   rewrite is reported as bad output rather than being quietly ignored: a
   *   silently dropped rewrite leaves its author believing the call was changed.
   */
  readonly rewritable?: boolean | undefined;
  /**
   * This event's name in the dialect written outside Clarvis, when it has one.
   *
   * @remarks Placed on the stdin payload as `hook_event_name` so a hook authored
   *   for another host compares against the spelling it expects. Absent for a
   *   Clarvis-only event, where the payload falls back to our own name.
   */
  readonly externalEvent?: string | undefined;
}

/**
 * Why a hook produced no verdict.
 *
 * @remarks
 * A missing command is `exit_nonzero` with code 127, not `spawn_failed` — what
 * gets spawned is the shell, and the shell exists. `spawn_failed` means the
 * shell itself could not be started.
 */
export type HookFailureKind =
  "spawn_failed" | "timeout" | "exit_nonzero" | "bad_output" | "aborted";

/** A hook failure, with enough detail to diagnose it from a log line. */
export interface HookFailure {
  readonly kind: HookFailureKind;
  /** One line, operator-facing. Never contains the hook's stdin payload. */
  readonly message: string;
  readonly exitCode?: number | undefined;
  readonly signal?: string | undefined;
  /** Tail of the child's stderr, clamped. Logged, never sent to the model. */
  readonly stderr?: string | undefined;
}

/**
 * What a hook decided.
 *
 * @remarks
 * `context` contributes text to the run's pinned entry context and is meaningful
 * only at a session-start fire point; at a gate the host treats it as
 * {@link HookFailureKind | bad_output}, because a gate has no context channel.
 *
 * `rewrite` replaces the pending call's arguments wholesale and is meaningful
 * only where {@link HookInvocation.rewritable} is set. Its optional `message` is
 * the advice a hook offered alongside the replacement, since the source dialect
 * lets one body carry both.
 */
export type HookOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "deny"; readonly message: string }
  | { readonly kind: "advise"; readonly message: string }
  | { readonly kind: "context"; readonly text: string }
  | { readonly kind: "rewrite"; readonly arguments: object; readonly message?: string };

/** The full record of one hook execution, successful or not. */
export type HookResult =
  | {
      readonly ok: true;
      readonly hook: HookSpec;
      readonly outcome: HookOutcome;
      readonly durationMs: number;
    }
  | {
      readonly ok: false;
      readonly hook: HookSpec;
      readonly failure: HookFailure;
      readonly durationMs: number;
    };

/**
 * Minimal structural logger.
 *
 * @remarks
 * Deliberately not the loop's `Logger` interface — see the note on this module.
 * The loop's logger satisfies this shape, so a host passes its own straight in.
 */
export interface HookLogger {
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

/**
 * A {@link HookLogger} that discards everything.
 *
 * @remarks Lets this package's own call sites be unconditional rather than
 *   optional-chained; the package holds a 1.00/1.00 coverage floor, so every
 *   `logger?.` would be a branch a test has to drive both ways for nothing.
 */
export const NOOP_HOOK_LOGGER: HookLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
