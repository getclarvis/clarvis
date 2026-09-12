import { createHash } from "node:crypto";
import {
  type ShellFacts,
  type Guard,
  type GuardContext,
  type GuardDecision,
  withinWorkspace,
  touchesOutside,
  isDangerousCommand,
  type GuardPlacement,
} from "@clarvis/tools/guard";
import { globToRegExp } from "./glob.ts";
import { commandComparison } from "./command-comparison.ts";

/**
 * Which of the guard's fixed rules produced a verdict.
 *
 * @remarks A stable machine vocabulary, unlike {@link GuardDecision.reason},
 * which is prose for a human and free to change. An operator auditing approvals
 * greps this, not the sentence.
 */
export type ShellGuardMatch =
  | "deny_list"
  | "allow_list"
  | "undecidable"
  | "outside_workspace"
  | "credential_file"
  | "host_command"
  | "dangerous"
  | "non_bash"
  | "default";

/**
 * One ruling, as an observer sees it.
 *
 * @remarks Carries a digest of the command rather than the command, because a
 * command line routinely holds a token, a password or a private path and this
 * record's whole purpose is to be durable. The digest is still enough to tell
 * "the same command was approved twice" from "two different commands were".
 */
export interface ShellGuardDecision {
  /** The tool the ruling was made for. */
  readonly tool: string;
  /** The ruling itself. */
  readonly verdict: GuardDecision["verdict"];
  /** The rule that produced it. */
  readonly matched: ShellGuardMatch;
  /** The human-facing explanation, when the rule supplies one. */
  readonly reason?: string;
  /** Present when the ruling bars every automatic answerer. */
  readonly escalate?: "human";
  /** First 16 hex of the SHA-256 of the command text, when the call carries one. */
  readonly commandDigest?: string;
}

/**
 * Options for {@link createShellGuard}.
 * Command entries may include `*` globs matched against normalized bash segments.
 */
export interface ShellGuardOptions {
  /** Complete host proof may refine syntactic uncertainty, never a deterministic denial. */
  attestedReviewable?: (ctx: GuardContext) => boolean;
  /** Auto review lets the judge answer explicit unsandbox asks; ordinary Host opacity stays human-only. */
  allowHostJudge?: boolean;
  /** Host-attested run placement; omitted means ordinary host execution. */
  placement?: GuardPlacement;
  /** Native networking policy; container outbound modes are deliberately omitted. */
  network?: "none" | "host";
  /**
   * Segments that pass without asking when the whole command's segments are all
   * covered; a plain entry matches a segment exactly or as a `<entry> …` prefix,
   * an entry containing `*` matches as a glob.
   */
  allowedCommands?: string[];
  /**
   * Segments that force a `deny` when any one of the command's segments matches;
   * same plain-prefix / `*`-glob matching as {@link ShellGuardOptions.allowedCommands}.
   * Checked before everything else, so a denied segment always wins.
   */
  deniedCommands?: string[];
  /**
   * Observer notified of every ruling, after it is decided and before it is
   * returned.
   *
   * @remarks The guard stays a pure function of its context: this is a
   * host-supplied sink, it cannot change a verdict, and a throw from it
   * propagates to the caller rather than being swallowed into a silent
   * approval. The kernel binds it in `createGuardResolver`, which is where the
   * run's identity and the audit logger already live.
   */
  onDecision?: (decision: ShellGuardDecision) => void;
}

/**
 * Files that hold credentials, matched against the basename (or trailing path
 * segments) of every path a command touches.
 *
 * @remarks
 * Workspace confinement is the wrong instrument here: these files sit *inside*
 * the workspace as often as not — a project's own `.env`, a checked-out deploy
 * key — so every path check upstream of this one says "fine, that's local".
 * Reading them is frequently legitimate, which is why the verdict is `ask` and
 * not `deny`; doing it without the user knowing is what is not.
 *
 * The list is not an attempt to enumerate every secret-bearing file, which is
 * not possible — a secret can live anywhere. It names the conventional locations
 * whose *name alone* is sufficient evidence, in three families: the ambient
 * project secret (`.env`), private key material by extension or well-known
 * basename (`.pem`, `.key`, `id_rsa`, `id_ed25519`, everything under `.ssh/`),
 * and the credential stores specific tools are known to write (`.npmrc`,
 * `.netrc`, `.git-credentials`, `.aws/credentials`, `keys.json`). A name that
 * needs its *contents* inspected to know it holds a secret is out of scope by
 * construction, since this check never opens the file.
 *
 * Since the verdict is `ask`, a false positive costs one prompt and a false
 * negative costs a silent read — so the list errs towards matching, and
 * {@link SENSITIVE_PATH_EXCEPTIONS} carves back only the cases common enough
 * that prompting would train the user to approve.
 */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/,
  /\.pem$/,
  /\.key$/,
  /(^|\/)id_rsa/,
  /(^|\/)id_ed25519/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.ssh\//,
  /(^|\/)keys\.json$/,
];

/**
 * Sample files that look sensitive but carry no secret, and are read constantly.
 *
 * @remarks Prompting for `.env.example` is how a guard teaches the answer
 *   "approve" — the file is committed to the repository precisely because it
 *   holds nothing.
 */
const SENSITIVE_PATH_EXCEPTIONS: RegExp[] = [/(^|\/)\.env\.(example|sample|template)$/];

/**
 * Reports whether a command touches a credential-bearing file.
 *
 * @param ctx - the guard context, read for its resolved {@link GuardContext.paths}.
 * @returns the first matching path, or `undefined` when none matches.
 */
function sensitivePath(ctx: GuardContext): string | undefined {
  for (const p of ctx.paths) {
    const candidate = p.raw;
    if (SENSITIVE_PATH_EXCEPTIONS.some((re) => re.test(candidate))) continue;
    if (SENSITIVE_PATH_PATTERNS.some((re) => re.test(candidate))) return candidate;
  }
  return undefined;
}

/**
 * Predicate over a single normalized bash segment, compiled from one allow/deny
 * list entry by {@link compileCommandEntry}.
 */
type EntryMatcher = (normalized: string) => boolean;

/**
 * Compiles one allow/deny list entry into an {@link EntryMatcher}.
 *
 * @param entry - a list entry; trimmed first. An empty entry never matches. An
 *   entry with no `*` matches a segment exactly or as a `<entry> …` prefix; an
 *   entry with `*` is matched as an anchored glob via {@link globToRegExp}.
 * @returns a predicate that reports whether a normalized segment matches.
 */
function compileCommandEntry(entry: string): EntryMatcher {
  const e = entry.trim();
  if (e === "") return () => false;
  if (!e.includes("*")) return (n) => n === e || n.startsWith(e + " ");
  const re = globToRegExp(e);
  return (n) => re.test(n);
}

/**
 * Reports whether every segment of a command is covered by the allow list.
 *
 * @param bash - the parsed bash facts for the command.
 * @param matchers - the compiled allow-list matchers.
 * @returns `true` only if the command is decidable, has at least one segment,
 *   and every segment matches at least one matcher — an undecidable or empty
 *   command is never allowed.
 */
function commandsAllowed(
  bash: ShellFacts,
  commands: Array<string | undefined>,
  matchers: EntryMatcher[],
): boolean {
  if (bash.undecidable) return false;
  if (bash.segments.length === 0) return false;
  if (bash.segments.some((segment) => segment.envAssignments.length > 0)) return false;
  return commands.every((command) => command === undefined || matchers.some((m) => m(command)));
}

/**
 * Reports whether any segment of a command is covered by the deny list.
 *
 * @param bash - the parsed bash facts for the command.
 * @param matchers - the compiled deny-list matchers.
 * @returns `true` if at least one segment's normalized form matches at least one
 *   matcher.
 * @remarks
 * Normalized form only. Matching the raw segment text as well was tried and
 * removed: entries match exactly or as a space-boundary prefix, so a command
 * smuggled through an expansion the tokenizer discards — `$(echo git) push
 * origin main`, whose raw text starts with `$(` — never matched a `git push`
 * entry anyway. It added false-positive surface and caught nothing. That case
 * is handled where it belongs, by refusing to let an unanalyzable command past
 * a deny list at all; see {@link createShellGuard}.
 */
function commandDenied(bash: ShellFacts, matchers: EntryMatcher[]): boolean {
  return bash.segments.some((s) => matchers.some((m) => m(s.normalized)));
}

/** One rule's outcome: a {@link GuardDecision} plus the rule that produced it. */
type Ruling = GuardDecision & { matched: ShellGuardMatch };

/**
 * The observable identity of a command, without the command.
 *
 * @param ctx - the guard context whose `args.command` is digested.
 * @returns a one-key object to spread, empty when the call carries no command
 *   string — a non-bash tool has nothing to digest, and an empty digest field
 *   would read as "the empty command".
 */
function digestOf(ctx: GuardContext): { commandDigest?: string } {
  const command = ctx.args.command;
  if (typeof command !== "string" || command.length === 0) return {};
  return { commandDigest: createHash("sha256").update(command).digest("hex").slice(0, 16) };
}

/**
 * Tool guard for bash (and path-touching) calls: deny lists, allow lists, path bounds, otherwise ask.
 *
 * @param opts - optional allow/deny command lists; see {@link ShellGuardOptions}.
 * @returns a {@link Guard} evaluated in fixed precedence for each call: a denied
 *   segment → `deny`; an undecidable command → `deny` when a deny list is
 *   configured, else `ask` (human-only on Host, reviewable when contained); a host command → `ask` through
 *   the configured reviewer; any path outside the workspace → `deny`; a
 *   credential file → `ask`; a non-bash call → `allow`; a fully
 *   allow-listed command → `allow`; forced removal or sudo → `ask`; a command that may leave the workspace →
 *   `ask`; otherwise `ask` (noting whether an allow list was configured at all).
 * @remarks
 * The guard only ever narrows toward asking or denying — it allows solely for
 * non-bash calls and commands matched in full by the allow list.
 *
 * The credential-file check sits after the deny list and before the allow list
 * on purpose: an operator's explicit `deny` still outranks it, but no allow-list
 * entry can wave `cat .env` through. `cat` is exactly the sort of entry a
 * starter allow list contains.
 *
 * The undecidable branch escalates to `deny` only for a **non-empty** deny list.
 * `denied_commands: []` means "deny nothing", and reading it as "a deny list
 * exists" would turn every unanalyzable command into an unappealable refusal —
 * `git commit -m "$MSG"` failing with no prompt — for a user who asked to deny
 * nothing at all.
 */
export function createShellGuard(opts?: ShellGuardOptions): Guard {
  const allowed = opts?.allowedCommands?.map(compileCommandEntry);
  const denied = opts?.deniedCommands?.map(compileCommandEntry);
  const onDecision = opts?.onDecision;
  const rule = (
    ctx: GuardContext,
    commands: Array<string | undefined>,
    placement: GuardPlacement,
  ): Ruling => {
    if (
      ctx.shell !== undefined &&
      denied !== undefined &&
      (commandDenied(ctx.shell, denied) ||
        commands.some((command) => command !== undefined && denied.some((match) => match(command))))
    ) {
      return {
        matched: "deny_list",
        verdict: "deny",
        reason: "command matches the denied commands list",
      };
    }
    const attested = opts?.attestedReviewable?.(ctx) === true;
    if (ctx.shell?.undecidable && !attested && denied !== undefined && denied.length > 0) {
      return {
        matched: "undecidable",
        verdict: "deny",
        reason:
          "command contains dynamic expansions that cannot be analyzed, so it cannot be " +
          "checked against the denied commands list",
      };
    }
    if (ctx.sandboxPermissions === "require_escalated" && ctx.config.sandbox !== undefined) {
      return {
        matched: "host_command",
        verdict: "ask",
        ...(opts?.allowHostJudge === true ? {} : { escalate: "human" as const }),
        reason:
          ctx.justification !== undefined && ctx.justification.length > 0
            ? ctx.justification
            : "this command will run outside the sandbox on the host",
      };
    }
    if (ctx.shell?.undecidable && !attested) {
      return {
        matched: "undecidable",
        verdict: "ask",
        ...(placement === "host" ? { escalate: "human" as const } : {}),
        reason: "command contains dynamic expansions that cannot be analyzed",
      };
    }
    if (touchesOutside(ctx)) {
      return {
        matched: "outside_workspace",
        verdict: "deny",
        reason: "command touches paths outside the workspace",
      };
    }
    if (ctx.shell?.segments.some((segment) => segment.envAssignments.length > 0)) {
      return {
        matched: "default",
        verdict: "ask",
        ...(placement === "host" ? { escalate: "human" as const } : {}),
        reason: "command changes an environment binding that has not been attested",
      };
    }
    const sensitive = sensitivePath(ctx);
    if (sensitive !== undefined) {
      return {
        matched: "credential_file",
        verdict: "ask",
        reason: `command touches a credential file (${sensitive})`,
      };
    }
    if (ctx.shell === undefined) {
      return { matched: "non_bash", verdict: "allow" };
    }
    if (allowed !== undefined && commandsAllowed(ctx.shell, commands, allowed)) {
      return { matched: "allow_list", verdict: "allow" };
    }
    if (isDangerousCommand(ctx.shell)) {
      return {
        matched: "dangerous",
        verdict: "ask",
        reason: "command uses forced removal or elevated privileges",
      };
    }
    if (!withinWorkspace(ctx)) {
      /**
       * Reached only when the command resolved to **no** paths at all: an
       * undecidable command and one that provably escapes have both already
       * returned above. That covers two cases this layer cannot tell apart — a
       * command that takes no path (`hostname`), and one whose paths the
       * extractor could not resolve (`cat x`) — so the ask stands, but the
       * reason must not assert an escape it has no evidence for. It used to say
       * "may touch paths outside the workspace" for `whoami`, and the model
       * read that as fact and invented explanations from it.
       */
      return {
        matched: "outside_workspace",
        verdict: "ask",
        reason: "the paths this command touches could not be determined",
      };
    }
    return {
      matched: "default",
      verdict: "ask",
      reason:
        allowed === undefined
          ? "no allowed commands list configured"
          : "command not in the allowed commands list",
    };
  };
  return (ctx: GuardContext): GuardDecision => {
    const comparison = commandComparison(ctx);
    const facts = { ...ctx, paths: comparison.paths };
    const unsandbox =
      ctx.sandboxPermissions === "require_escalated" && ctx.config.sandbox !== undefined;
    const placement = unsandbox ? "host" : (opts?.placement ?? "host");
    const { matched, ...decision } = rule(facts, comparison.commands, placement);
    onDecision?.({
      tool: ctx.tool,
      matched,
      verdict: decision.verdict,
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      ...(decision.escalate !== undefined ? { escalate: decision.escalate } : {}),
      ...digestOf(ctx),
    });
    return {
      ...decision,
      matched,
      placement,
      ...(!unsandbox && opts?.network !== undefined ? { network: opts.network } : {}),
      dangerous: ctx.shell !== undefined && isDangerousCommand(ctx.shell),
      within_workspace: withinWorkspace(facts),
      touches_outside: touchesOutside(facts),
    };
  };
}
