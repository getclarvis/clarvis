/**
 * Selecting, executing and resolving workspace hooks.
 *
 * @remarks
 * The runner is the whole public surface of this package: everything else is an
 * implementation detail it composes. It deliberately knows nothing about which
 * events exist or which of them are gates - the host says so per invocation -
 * so adding an event upstream never requires a change here.
 */
import { compileMatch, matchesCandidate, type CompiledMatch } from "./match.ts";
import { cleanHookMessage, parseHookStdout } from "./parse.ts";
import { runHookCommand, type SubprocessDeps, type SubprocessResult } from "./subprocess.ts";
import { NOOP_HOOK_LOGGER } from "./types.ts";
import type {
  HookFailure,
  HookInvocation,
  HookLogger,
  HookOutcome,
  HookResult,
  HookSpec,
} from "./types.ts";

/** Version of the stdin/stdout contract, sent as `protocol` and `CLARVIS_HOOK_PROTOCOL`. */
export const HOOK_PROTOCOL_VERSION = 1;

/**
 * Ceiling on the stdin payload.
 *
 * @remarks
 * Beyond this the `data` block is dropped and `data_truncated` set, rather than
 * the whole call failing: a hook filtering on the event and the tool name should
 * still fire when some argument happens to be enormous. The host clamps the
 * individual fields before they reach here; this is the backstop.
 */
export const MAX_STDIN_BYTES = 256 * 1024;

/** Longest stderr excerpt kept on a {@link HookFailure}. */
const STDERR_TAIL_CHARS = 2_000;

/**
 * Exit status by which a hook blocks a gated event without writing JSON.
 *
 * @remarks The external dialect's third blocking form, alongside
 * `permissionDecision: "deny"` and the legacy `decision: "block"`. Honoured only
 * at a gate: an observer event has no verdict to give, so there the same status
 * stays an ordinary non-zero exit.
 */
export const HOOK_BLOCKING_EXIT_CODE = 2;

/** How much of a hook command appears in a log field. */
const COMMAND_LOG_CHARS = 80;

/** Construction inputs for {@link createHookRunner}; `SubprocessDeps` are test seams. */
export interface HookRunnerDeps extends SubprocessDeps {
  /** Working directory for every hook command. */
  readonly workspaceRoot: string;
  /**
   * The child's environment, already filtered.
   *
   * @remarks
   * Filtering happens in the host, not here, because the authoritative denylist
   * is derived from the run's own provider configuration. See `filterHookEnv`.
   */
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly logger?: HookLogger | undefined;
  readonly killGraceMs?: number | undefined;
  readonly maxStdoutBytes?: number | undefined;
  /**
   * Identifier for the run, published to hooks as `session_id`.
   *
   * @remarks One of the fields the external dialect names as commonly used, and
   *   the only one of them a hook cannot derive for itself. Omitted rather than
   *   invented when the host has none.
   */
  readonly sessionId?: string | undefined;
}

/** Runs the hooks configured for a workspace. */
export interface HookRunner {
  /**
   * The subset of `hooks` this invocation fires, in configuration order.
   *
   * @remarks
   * Configuration order is load-bearing: the settings merge puts every operator
   * hook ahead of every plugin hook so that an operator always gets the first
   * verdict, and preserving that order here is what makes the guarantee real.
   */
  select(hooks: readonly HookSpec[], inv: HookInvocation): readonly HookSpec[];
  /** Executes one hook. Never rejects. */
  run(hook: HookSpec, inv: HookInvocation, signal?: AbortSignal): Promise<HookResult>;
  /** Folds a result - including a failure - into the outcome the host acts on. */
  resolve(result: HookResult, inv: HookInvocation): HookOutcome;
}

function tail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

function head(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

/**
 * Classifies a finished command.
 *
 * @remarks
 * The precedence is the design. `aborted` outranks `timeout` because a run that
 * was cancelled and also crossed its deadline is a cancellation, and only that
 * ordering keeps teardown from being reported as a policy failure. `exit_nonzero`
 * covers a signalled child too: the operator-facing fact is that the command
 * failed, and the signal itself rides along on the record.
 *
 * Note that a command which does not exist lands here as `exit_nonzero` with
 * code 127 - what gets spawned is the shell, and the shell exists.
 *
 * **Exit code 2 at a gate is a verdict, not a failure.** It is the third form
 * the external dialect documents for blocking a tool call, beside the two JSON
 * spellings {@link parseHookStdout} already reads, and it is the one a shell
 * script reaches for first because it needs no JSON at all. Classifying it as
 * `exit_nonzero` handed it to `on_failure`, which defaults to `pass` - so a hook
 * that had decided to block was silently allowed, the one direction that must
 * never be silent. The reason travels on stderr by that dialect's convention.
 */
function classify(res: SubprocessResult, inv: HookInvocation): HookFailure | HookOutcome {
  const gate = inv.gate;
  const stderr = tail(res.stderr, STDERR_TAIL_CHARS);
  const withStderr = (f: Omit<HookFailure, "stderr">): HookFailure =>
    stderr === "" ? f : { ...f, stderr };

  if (res.aborted) return withStderr({ kind: "aborted", message: "the run was cancelled" });
  if (res.timedOut) return withStderr({ kind: "timeout", message: "the command timed out" });
  if (res.spawnError !== undefined) {
    return withStderr({
      kind: "spawn_failed",
      message: `the shell could not be started (${res.spawnError})`,
    });
  }
  if (gate && res.exitCode === HOOK_BLOCKING_EXIT_CODE && res.signal === null) {
    return {
      kind: "deny",
      message: cleanHookMessage(stderr) || "denied by hook (no reason given)",
    };
  }
  if (res.exitCode !== 0 || res.signal !== null) {
    return withStderr({
      kind: "exit_nonzero",
      message:
        res.signal !== null
          ? `the command was killed by ${res.signal}`
          : `the command exited with code ${String(res.exitCode)}`,
      ...(res.exitCode !== null ? { exitCode: res.exitCode } : {}),
      ...(res.signal !== null ? { signal: res.signal } : {}),
    });
  }
  const parsed = parseHookStdout(res.stdout, {
    truncated: res.stdoutTruncated,
    allowContext: !gate,
    allowRewrite: inv.rewritable === true,
  });
  if (!parsed.ok) return withStderr({ kind: "bad_output", message: parsed.reason });
  return parsed.outcome;
}

const FAILURE_KINDS = new Set<string>([
  "spawn_failed",
  "timeout",
  "exit_nonzero",
  "bad_output",
  "aborted",
]);

/** The two unions share a `kind` field and no `kind` value, so the tag alone decides. */
function isFailure(v: HookFailure | HookOutcome): v is HookFailure {
  return FAILURE_KINDS.has(v.kind);
}

/** What {@link stdinPayload} produced, and whether the `data` block survived. */
interface StdinPayload {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * The fields that identify a fire point, independent of which event it is.
 *
 * @param inv - the fire point.
 * @param workspaceRoot - the directory every hook command runs in.
 * @param sessionId - the run identifier, when the host supplies one.
 * @returns the identity fields, under the names the external dialect uses.
 * @remarks
 * `hook_event_name` carries the **foreign** spelling of the event, because the
 * comparison a hook authored elsewhere makes is against `"PreToolUse"`; it falls
 * back to ours for an event the dialect has no word for. There is no second copy
 * of either field under a Clarvis name: publishing `event` beside
 * `hook_event_name`, and `workspace_root` beside `cwd`, would be a
 * back-compatibility shim for hooks that do not exist, which this repository's
 * pre-release rule explicitly forbids writing.
 */
function identityFields(
  inv: HookInvocation,
  workspaceRoot: string,
  sessionId: string | undefined,
): Record<string, unknown> {
  return {
    protocol: HOOK_PROTOCOL_VERSION,
    hook_event_name: inv.externalEvent ?? inv.event,
    cwd: workspaceRoot,
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
  };
}

/**
 * Builds the JSON written to a hook's stdin.
 *
 * @remarks
 * Arguments travel on stdin rather than argv so that no model-authored text ever
 * meets a shell tokenizer. The `command` string is the operator's own and is the
 * only thing the shell parses.
 *
 * The envelope is **flat**: the identity fields, then the event's own fields
 * spread beside them rather than nested under a `data` key. A hook reads
 * `tool_input.command` where the dialect says it does, and nothing appears
 * twice. `protocol` is a Clarvis extension the dialect has no counterpart for,
 * which is normal in both directions — it labels its own additions the same way.
 */
function stdinPayload(
  inv: HookInvocation,
  workspaceRoot: string,
  sessionId: string | undefined,
): StdinPayload {
  const identity = identityFields(inv, workspaceRoot, sessionId);
  const fields = typeof inv.data === "object" && inv.data !== null ? inv.data : {};
  let text: string;
  try {
    text = JSON.stringify({ ...identity, ...fields });
  } catch {
    text = "";
  }
  if (text !== "" && Buffer.byteLength(text, "utf8") <= MAX_STDIN_BYTES) {
    return { text, truncated: false };
  }
  return {
    text: JSON.stringify({ ...identity, payload_truncated: true }),
    truncated: true,
  };
}

/**
 * Creates a runner bound to one workspace and one filtered environment.
 *
 * @param deps - the workspace root, the child environment and any test seams.
 * @returns a {@link HookRunner}.
 * @remarks
 * Filters are compiled once per spec and cached by identity, so a hook that
 * fires on every tool call pays no regex construction after the first.
 */
export function createHookRunner(deps: HookRunnerDeps): HookRunner {
  const logger = deps.logger ?? NOOP_HOOK_LOGGER;
  const compiled = new WeakMap<HookSpec, { readonly m: CompiledMatch | undefined }>();
  /**
   * Each selected hook's position in the firing order, recorded by `select` so
   * `run` can name it. Configuration order is the guarantee the settings merge
   * exists to provide, so "which hook" is the position in it, and a runner has
   * no other way to know: `run` receives one spec, never the list.
   */
  const orderOf = new WeakMap<HookSpec, number>();
  const matchOf = (hook: HookSpec): CompiledMatch | undefined => {
    let entry = compiled.get(hook);
    if (entry === undefined) {
      entry = { m: compileMatch(hook.match, logger) };
      compiled.set(hook, entry);
    }
    return entry.m;
  };

  return {
    select(hooks, inv) {
      const forEvent = hooks.filter((h) => h.event === inv.event);
      const matched = forEvent.filter((h) => matchesCandidate(matchOf(h), inv.candidate));
      matched.forEach((h, index) => orderOf.set(h, index));
      logger.debug(
        {
          event: "hooks.selected",
          hook_event: inv.event,
          matched: matched.length,
          total: forEvent.length,
          broken_patterns: forEvent.filter((h) => matchOf(h)?.broken === true).length,
        },
        "hook selection decided which configured hooks fire for this event; a hook with a broken pattern is counted and never fires",
      );
      return matched;
    },

    async run(hook, inv, signal) {
      const timeoutMs = hook.timeout_ms ?? inv.defaultTimeoutMs;
      const payload = stdinPayload(inv, deps.workspaceRoot, deps.sessionId);
      const res = await runHookCommand(
        {
          command: hook.command,
          cwd: deps.workspaceRoot,
          env: {
            ...deps.baseEnv,
            CLARVIS_HOOK_PROTOCOL: String(HOOK_PROTOCOL_VERSION),
            CLARVIS_HOOK_EVENT: inv.event,
            CLARVIS_HOOK_GATE: inv.gate ? "1" : "0",
            CLARVIS_HOOK_TIMEOUT_MS: String(timeoutMs),
            CLARVIS_WORKSPACE_ROOT: deps.workspaceRoot,
            ...(inv.candidate !== undefined ? { CLARVIS_HOOK_TOOL: inv.candidate.tool } : {}),
            ...(inv.candidate?.aliases?.[0] === undefined
              ? {}
              : { CLARVIS_HOOK_TOOL_FULL_NAME: inv.candidate.aliases[0] }),
          },
          stdin: payload.text,
          timeoutMs,
          killGraceMs: deps.killGraceMs,
          maxStdoutBytes: deps.maxStdoutBytes,
          signal,
          diagnostics: { hookEvent: inv.event, dataTruncated: payload.truncated },
        },
        deps,
      );

      const verdict = classify(res, inv);
      if (isFailure(verdict)) {
        logger.warn(
          {
            event: "hooks.command_failed",
            hook_event: hook.event,
            command: head(hook.command, COMMAND_LOG_CHARS),
            err_kind: verdict.kind,
            exit_code: verdict.exitCode,
            signal: verdict.signal,
            stderr_tail: verdict.stderr,
            duration_ms: res.durationMs,
          },
          "workspace hook failed",
        );
        return { ok: false, hook, failure: verdict, durationMs: res.durationMs };
      }
      const fields = {
        event: "hooks.verdict",
        hook_event: hook.event,
        kind: verdict.kind,
        hook_index: orderOf.get(hook) ?? -1,
        duration_ms: res.durationMs,
      };
      if (verdict.kind === "deny") {
        logger.info(fields, "a workspace hook denied the pending tool call; the call does not run");
      } else if (verdict.kind === "rewrite") {
        logger.info(
          fields,
          "a workspace hook replaced the pending tool call's arguments; the call runs with the replacement, which still meets the tool schema and the guard",
        );
      } else {
        logger.debug(fields, "a workspace hook returned a verdict");
      }
      return { ok: true, hook, outcome: verdict, durationMs: res.durationMs };
    },

    resolve(result, inv) {
      if (result.ok) {
        if (!inv.gate && result.outcome.kind === "deny") return { kind: "pass" };
        return result.outcome;
      }
      if (result.failure.kind === "aborted") return { kind: "pass" };
      if (!inv.gate) return { kind: "pass" };
      if (result.hook.on_failure !== "deny") return { kind: "pass" };
      return { kind: "deny", message: `a workspace hook failed: ${result.failure.message}` };
    },
  };
}
