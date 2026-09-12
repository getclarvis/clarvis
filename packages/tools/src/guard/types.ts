import type { RuntimeConfig } from "../config.ts";

/**
 * A guard's ruling on a tool call: run it silently (`allow`), refuse it
 * outright (`deny`), or route it to the human via {@link Elicit} (`ask`).
 */
export type Verdict = "allow" | "deny" | "ask";

/** Execution boundary committed to for this call, not an approval verdict. */
export type GuardPlacement = "host" | "contained";

/** Trusted host facts for one review; never populated from model-supplied arguments. */
export interface GuardCallFacts {
  matched?: string;
  placement?: GuardPlacement;
  network?: "none" | "host";
  dangerous?: boolean;
  within_workspace?: boolean;
  touches_outside?: boolean;
}

/**
 * A {@link Guard}'s answer for one tool call: the {@link Verdict} plus an
 * optional human-facing `reason` shown when the verdict is `ask` or `deny`.
 */
export interface GuardDecision extends GuardCallFacts {
  verdict: Verdict;
  reason?: string;
  /** Host-resolved command-review mode, when exposed for audit and display. */
  mode?: "on" | "auto";
  /**
   * Restricts who may answer an `ask`: `"human"` bars every automatic answerer,
   * so the question reaches a person or the call fails closed.
   *
   * @remarks
   * Reserved for host commands the analyzer cannot bound and requests to leave
   * the sandbox when the host policy requires human review. Auto may instead
   * route an explicit unsandbox request to its judge. An undecidable command committed to containment does
   * not by itself require this restriction; the host policy owns that decision.
   *
   * The union has one member because the resolver implements one restriction:
   * *bar every automatic answerer*. A second spelling would have to name a
   * partial restriction — bar the session allow list but keep the judge, say —
   * and there is no branch that could act on one; `escalate === "human"` takes
   * the human channel or fails closed, and everything else takes the ordinary
   * path. It is one value because there is one behaviour, not because the others
   * are still to be written, and widening it means writing that branch first.
   */
  escalate?: "human";
}

/** Channel that produced the final answer to an `ask` verdict. */
export type GuardAnswerer = "human" | "judge" | "session_allowlist" | "unavailable";

/** Rich guard answer; boolean answers remain accepted for third-party guards. */
export interface GuardElicitAnswer {
  allowed: boolean;
  answerer: GuardAnswerer;
}

/** Final command-review fact attached to a dispatched tool result. */
export interface GuardReview {
  mode: "on" | "auto";
  outcome: "allowed" | "denied";
  answerer: GuardAnswerer | "policy";
}

/**
 * One command from a shell string, split off at a top-level statement or
 * pipeline separator and stripped of leading env assignments and safe wrappers
 * (see {@link analyzeShell}).
 *
 * @remarks
 * `decidable` is `false` when the segment contains a construct the analyzer
 * cannot reason about statically (command/parameter/process substitution,
 * `eval`/`exec`, unbalanced quotes, etc.); a guard must treat an undecidable
 * segment as unknown rather than safe.
 */
export interface Segment {
  command: string;
  argv: string[];
  normalized: string;
  /** Env-assignment prefixes stripped from `normalized` (e.g. `FOO=bar`). Approval
   * keys must include them - keyed on `normalized` alone, `LD_PRELOAD=... cmd`
   * would ride a plain `cmd` grant. */
  envAssignments: string[];
  decidable: boolean;
}

/**
 * The static analysis of a shell command produced by {@link analyzeShell}: the
 * filesystem `paths` it appears to touch, its {@link Segment}s, and whether the
 * whole command is `undecidable`.
 *
 * @remarks
 * `undecidable` is `true` if any segment is not {@link Segment.decidable},
 * quotes/parens are unbalanced, a path token resolves through a `~user` /
 * `..` glob the analyzer cannot pin down, or a segment tokenized to no argv
 * and no env assignments; a `true` value means the reported `paths` are not a
 * complete picture, so never treat it as workspace-confined.
 */
export interface ShellFacts {
  paths: string[];
  segments: Segment[];
  undecidable: boolean;
}

/**
 * A single path argument as the guard sees it: the `raw` token the caller
 * passed, its absolute `resolved` form, and whether it stays
 * `withinWorkspace`.
 *
 * @remarks
 * `withinWorkspace` is computed by re-resolving `raw` in confining mode (see
 * {@link resolveCandidate}); a symlink or `..` that escapes the workspace root
 * makes it `false`.
 */
export interface PathFact {
  raw: string;
  resolved: string;
  withinWorkspace: boolean;
}

/**
 * Everything a {@link Guard} needs to rule on one tool call: the `tool` name,
 * its raw `args`, the active {@link RuntimeConfig}, the {@link PathFact}s the
 * call touches, and, for command tools, the {@link ShellFacts} analysis.
 *
 * @remarks
 * `shell` is present only for command-running tools (`shell`, `monitor_start`);
 * `paths` is populated per tool by {@link buildGuardContext}.
 */
export interface GuardContext {
  tool: string;
  args: Record<string, unknown>;
  config: RuntimeConfig;
  paths: PathFact[];
  shell?: ShellFacts;
  /** Per-call sandbox posture for `shell` and `monitor_start`. */
  sandboxPermissions?: "use_default" | "require_escalated";
  /** Operator-facing reason supplied with `require_escalated`. */
  justification?: string;
}

/**
 * A policy function that inspects a {@link GuardContext} and returns a
 * {@link GuardDecision}, synchronously or asynchronously.
 */
export type Guard = (ctx: GuardContext) => GuardDecision | Promise<GuardDecision>;

/**
 * The payload handed to an {@link Elicit} when a guard's verdict is `ask`: the
 * `tool` and `args` in question, the guard's `reason`, and any {@link ShellFacts}
 * so the prompt can show the analyzed command.
 */
export interface ElicitRequest extends GuardCallFacts {
  tool: string;
  args: Record<string, unknown>;
  reason?: string;
  /** Human-facing context added by the host reviewer, separate from policy reason. */
  operator_message?: string;
  shell?: ShellFacts;
  /**
   * Carried over from {@link GuardDecision.escalate}: `"human"` means no
   * automatic answerer may resolve this prompt.
   */
  escalate?: "human";
}

/**
 * The host-supplied prompt that decides an `ask` verdict: it receives an
 * {@link ElicitRequest} and returns `true` to run the call or `false` to
 * refuse, synchronously or asynchronously.
 */
export type Elicit = (
  req: ElicitRequest,
) => boolean | GuardElicitAnswer | Promise<boolean | GuardElicitAnswer>;
