import { resolve } from "node:path";
import type {
  ShellFacts,
  Elicit,
  ElicitParams,
  GuardElicit,
  ElicitRequest as GuardElicitRequest,
} from "@clarvis/loop";
import type { ElicitationCommandDetail } from "@clarvis/protocol";

/**
 * Practical “no timeout” ceiling for guard confirmation prompts (`2^31 - 1` ms).
 *
 * @remarks
 * The number is the largest delay `setTimeout` accepts, so a backend that turns it into a timer gets
 * a bound that fires rather than one that overflows to immediate — the same derivation
 * `MAX_TIMER_DELAY_MS` carries in the engine's `bounded.ts`.
 *
 * It is passed **explicitly** rather than omitted because the `Elicit` port documents `timeoutMs` as
 * a wait bound a backend honours, and an omitted one means *unbounded*. So the sentinel is this
 * function's declaration that a command approval always terminates, addressed to whatever backend is
 * wired in. The kernel's own backend, `createElicitBridge`, does not read it — it listens for
 * `opts.signal` and starts no timer — which makes the value a statement of contract here rather than
 * an observed timer. The wait that actually bounds a guard prompt is applied one layer above, by the
 * engine's `withGuardElicitWaitBound` over the run's `elicit_wait_ms`.
 */
const ELICIT_NO_TIMEOUT_MS = 2_147_483_647;

const UNDECIDABLE_WARNING = "Warning: this command contains undecidable expansions.";

/**
 * Engine elicit params extended with the structured command context. The engine
 * pipes params through opaquely, so the elicit bridge can lift `detail` onto the
 * protocol {@link ElicitationRequest} without the loop knowing the shape.
 */
export type GuardElicitParams = ElicitParams & { detail?: ElicitationCommandDetail };

/**
 * Session-scoped allowlist of user-approved commands. Keys are full normalized
 * bash segments — env-assignment prefixes included — matched exactly, never by
 * prefix, so a re-run of an approved command passes silently while any changed
 * flag, argument or env assignment asks again.
 * Lives only as long as its kernel; never persisted.
 */
export interface GuardSessionAllowlist {
  /**
   * Reports whether a command is already covered — its every segment previously
   * recorded. An undecidable or empty command is never covered.
   */
  covers(bash: ShellFacts): boolean;
  /**
   * Records each segment of a command as approved for the rest of the session;
   * a no-op for an undecidable or empty command.
   */
  record(bash: ShellFacts): void;
}

/**
 * The exact allowlist key for one segment: its env-assignment prefixes and
 * normalized command joined by spaces, so a changed env assignment keys
 * differently and asks again.
 */
const sessionKey = (s: ShellFacts["segments"][number]): string =>
  [...s.envAssignments, s.normalized].join(" ");

/**
 * Creates an in-memory {@link GuardSessionAllowlist} backed by a `Set` of
 * {@link sessionKey}s.
 *
 * @returns a fresh allowlist that lives only for the caller's session and is
 *   never persisted.
 */
export function createGuardSessionAllowlist(): GuardSessionAllowlist {
  const approved = new Set<string>();
  return {
    covers(bash): boolean {
      if (bash.undecidable || bash.segments.length === 0) return false;
      return bash.segments.every((s) => approved.has(sessionKey(s)));
    },
    record(bash): void {
      if (bash.undecidable || bash.segments.length === 0) return;
      for (const s of bash.segments) approved.add(sessionKey(s));
    },
  };
}

/** Options for {@link createGuardElicit}. */
export interface GuardElicitOptions {
  /** Aborts a pending confirmation prompt when the run is cancelled. */
  signal?: AbortSignal;
  /** Where an `allow_session` answer records; its presence enables the option. */
  allowlist?: GuardSessionAllowlist;
  /** Fallback (and base for relative `cwd` args) of the structured detail. */
  workspaceRoot?: string;
}

/**
 * Adapts engine `Elicit` into a boolean {@link GuardElicit} for tool confirmations:
 * deny / allow once / allow for the rest of the session.
 *
 * @param elicit - the engine elicit port that surfaces the prompt to the user.
 * @param opts - optional signal, session allowlist, and workspace root; see
 *   {@link GuardElicitOptions}.
 * @returns a {@link GuardElicit} that builds a `guard_confirm` prompt (reason,
 *   the `$ command` or its segments, an undecidable warning), offers
 *   `allow_session` only when an {@link GuardElicitOptions.allowlist} is present
 *   and the command is decidable and non-empty, and attaches structured
 *   {@link ElicitationCommandDetail} when a `command` arg and
 *   {@link GuardElicitOptions.workspaceRoot} are both known.
 * @remarks Resolves `true` only on an accepted `allow` (or an accepted
 *   `allow_session`, which also records the command on the allowlist); any
 *   non-accept action or a `deny` resolves `false`. It passes
 *   {@link ELICIT_NO_TIMEOUT_MS} as the port-level ceiling and otherwise waits on
 *   the signal; the wait that really bounds the prompt is the engine's
 *   `withGuardElicitWaitBound` over the run's `elicit_wait_ms`, which fails closed
 *   to a denial when it expires.
 */
export function createGuardElicit(elicit: Elicit, opts?: GuardElicitOptions): GuardElicit {
  return async (req: GuardElicitRequest): Promise<boolean> => {
    const reason = req.reason ?? `Tool "${req.tool}" requires confirmation.`;
    const messageParts = [reason];
    const command = typeof req.args?.command === "string" ? req.args.command : undefined;
    if (command !== undefined && command.trim().length > 0) {
      messageParts.push(`$ ${command}`);
    } else if (req.shell) {
      messageParts.push(
        `Command segments: ${req.shell.segments.map((s) => s.normalized).join(", ")}`,
      );
    }
    if (req.shell?.undecidable) messageParts.push(UNDECIDABLE_WARNING);
    const session =
      opts?.allowlist !== undefined &&
      req.shell !== undefined &&
      !req.shell.undecidable &&
      req.shell.segments.length > 0
        ? { allowlist: opts.allowlist, shell: req.shell }
        : undefined;
    const params: GuardElicitParams = {
      message: messageParts.join("\n\n"),
      kind: "guard_confirm",
      requestedSchema: {
        type: "object",
        properties: {
          decision: {
            type: "string",
            enum: session !== undefined ? ["deny", "allow", "allow_session"] : ["deny", "allow"],
            description:
              session !== undefined
                ? "Deny, allow once, or allow this command for the rest of the session."
                : "Allow or deny this tool call.",
          },
        },
        required: ["decision"],
      },
    };
    const cwdArg = typeof req.args?.cwd === "string" ? req.args.cwd : undefined;
    if (command !== undefined && opts?.workspaceRoot !== undefined) {
      params.detail = {
        command,
        cwd: cwdArg !== undefined ? resolve(opts.workspaceRoot, cwdArg) : opts.workspaceRoot,
        reason,
        ...(req.shell?.undecidable ? { warning: UNDECIDABLE_WARNING } : {}),
      };
    }
    const result = await elicit(params, {
      timeoutMs: ELICIT_NO_TIMEOUT_MS,
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    });
    if (result.action !== "accept") return false;
    const decision = (result.content as { decision?: unknown } | undefined)?.decision;
    if (decision === "allow") return true;
    if (decision === "allow_session" && session !== undefined) {
      session.allowlist.record(session.shell);
      return true;
    }
    return false;
  };
}
