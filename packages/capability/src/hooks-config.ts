/**
 * The vocabulary of a workspace hook: its event groups, its per-class timeout
 * defaults, and the schema one configured entry is validated against.
 *
 * @remarks This is contract rather than implementation, and it lives here for a
 * structural reason. The declaring half (`HOOKS_SETTINGS_FIELDS` and the
 * settings spec, which the engine's settings/plugin/request schemas load
 * eagerly) and the executing half (`@clarvis/hooks/capability`, which the engine
 * loads only when hooks are enabled) both read these values. A value the eager
 * half reaches must live in a package that is never optional, or configuring the
 * engine would require the optional feature package to be installed — and
 * `builtins.hooks = false` would stop meaning what it says. The eleven
 * `*Context` types and {@link LifecycleHook} itself already live here for the
 * same reason.
 */
import { z } from "zod";

/** Registry name of the hooks capability. */
export const HOOKS_CAPABILITY_NAME = "hooks";

/**
 * The lifecycle events whose hooks can control the loop: their verdict blocks
 * (`deny`) or annotates (`advise`) the pending decision. All other events are
 * observer-only. `on_failure: "deny"` is valid only for these.
 */
export const GATE_HOOK_EVENTS = [
  "pre_tool_use",
  "post_tool_use",
  "pre_finalize",
  "pre_delegate_task",
] as const;

/**
 * The lifecycle events whose hooks only observe: the command runs, its output is
 * ignored, and no verdict of theirs can block the run.
 */
export const OBSERVER_HOOK_EVENTS = [
  "run_start",
  "run_end",
  "subagent_complete",
  "model_call_error",
  "budget_exhausted",
  "user_steer",
] as const;

/**
 * The events whose hooks contribute to a compaction's summarization prompt.
 *
 * @remarks
 * A `pre_compact` hook's `{"kind":"context","text":"..."}` output is appended to
 * the prompt the agent's profile resolved — it never replaces it. This is a
 * group of its own rather than a second member of {@link CONTEXT_HOOK_EVENTS}
 * because the two share a wire shape and differ in *destination*: a
 * `session_start` text is pinned into the run's entry context, while this one
 * reaches only the summarizer's own request and never enters the transcript.
 * Naming them apart is what stops a later event from silently inheriting the
 * wrong destination.
 */
export const COMPACTION_HOOK_EVENTS = ["pre_compact"] as const;

/**
 * The events whose hooks contribute entry context rather than a verdict.
 *
 * @remarks
 * A `session_start` hook's `{"kind":"context","text":"..."}` output is collected
 * into the run's pinned entry-context block, which is injected once per run as a
 * non-evictable user entry and therefore survives compaction rather than being
 * re-injected after it. That is the whole reason this is its own group and not a
 * fourth kind of observer: an observer's output is discarded by definition.
 */
export const CONTEXT_HOOK_EVENTS = ["session_start"] as const;

/**
 * How each Clarvis lifecycle event is spelled in the hooks dialect written
 * outside Clarvis.
 *
 * @remarks
 * The single owner of the correspondence, in both directions. `@clarvis/hooks`
 * reads it forwards, to put a name a foreign hook recognizes on the stdin
 * payload; the kernel's plugin-manifest reader inverts it, to translate a
 * foreign hooks document into Clarvis events. Two hand-written tables would be
 * two things to drift, and the drift would be silent in the worst way: a hook
 * would install and run while reading an event name it never matches.
 *
 * `Stop` pairs with `pre_finalize` because both are the gate a host gets before
 * an agent may finish, and `SessionEnd` with `run_end` for the same structural
 * reason. Events with no counterpart on either side are absent on purpose — an
 * approximation that fires at the wrong moment is worse than an honest gap.
 */
export const EXTERNAL_HOOK_EVENT_NAMES: Readonly<Record<string, string>> = {
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
  pre_compact: "PreCompact",
  session_start: "SessionStart",
  run_end: "SessionEnd",
  subagent_complete: "SubagentStop",
  pre_finalize: "Stop",
  user_steer: "UserPromptSubmit",
};

/**
 * How each tool name written in the external hooks dialect is spelled here.
 *
 * @remarks
 * A hook filter names the tools it fires on, and the two vocabularies disagree
 * on almost every entry a real rule reaches for. Measured against a public
 * catalog of 196 plugins, five of the thirty-nine names their filters used
 * existed here; the other thirty-four — `Write`, `Edit`, `Bash` and
 * `MultiEdit` above all — translated cleanly, installed, were approved, and
 * then matched nothing. That failure is silent in the worst direction: the
 * commonest such rule is a gate that blocks a dangerous shell command, and a
 * gate that never fires reads exactly like a gate that allowed everything.
 *
 * Keyed by {@link normalizeToolName} so one entry covers every capitalization
 * and separator a document writes the same name in. Every foreign name that has
 * a counterpart is listed, including the ones that differ only in case: an
 * unmapped name is carried through exactly as written, and `Grep` carried
 * through is a pattern that never matches `grep`.
 *
 * Names with no counterpart at all belong in
 * {@link EXTERNAL_TOOLS_WITHOUT_COUNTERPART}, not here. Mapping one onto its
 * nearest relative would make a filter fire on a call its author never meant,
 * which is worse than the honest gap an operator can read.
 */
export const EXTERNAL_TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: "shell",
  shell: "shell",
  read: "read_file",
  readfile: "read_file",
  write: "write_file",
  writefile: "write_file",
  edit: "edit_file",
  editfile: "edit_file",
  multiedit: "multi_edit",
  applypatch: "apply_patch",
  glob: "glob",
  grep: "grep",
  ls: "list_dir",
  listdir: "list_dir",
  task: "delegate_task",
};

/**
 * Tool names the external dialect has and this host does not.
 *
 * @remarks
 * Listed so a filter naming one is reported rather than carried through as an
 * exact-match pattern that can never match. The reasoning is
 * {@link EXTERNAL_HOOK_EVENT_NAMES}': an approximation that fires at the wrong
 * moment is worse than a gap the operator is told about.
 */
export const EXTERNAL_TOOLS_WITHOUT_COUNTERPART: ReadonlySet<string> = new Set([
  "exitplanmode",
  "todowrite",
  "notebookedit",
  "webfetch",
  "websearch",
]);

/**
 * Reduce a tool name to the form {@link EXTERNAL_TOOL_NAMES} is keyed by:
 * letters and digits only, lower-cased.
 *
 * @param name - the tool name as a document writes it.
 * @returns the lookup key.
 * @remarks The same normalization the event names use, and for the same reason:
 *   the alternative is an alias table per spelling of every entry.
 */
export function normalizeToolName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9]/g, "").toLowerCase();
}

const HOOK_EVENTS = [
  ...GATE_HOOK_EVENTS,
  ...OBSERVER_HOOK_EVENTS,
  ...CONTEXT_HOOK_EVENTS,
  ...COMPACTION_HOOK_EVENTS,
] as const;

const TOOL_SCOPED_EVENTS = new Set<string>(["pre_tool_use", "post_tool_use"]);
const GATE_EVENT_SET = new Set<string>(GATE_HOOK_EVENTS);

/**
 * The events whose hooks offer text and can never fail the run, so `on_failure`
 * is meaningless on them: both the entry-context and the compaction-prompt
 * contributors simply contribute nothing when they fail.
 */
const OFFERING_EVENT_SET = new Set<string>([...CONTEXT_HOOK_EVENTS, ...COMPACTION_HOOK_EVENTS]);

/**
 * Default `timeout_ms` per class of event, in milliseconds.
 *
 * @remarks
 * The tool events get the short budget rather than the gate one because they
 * fire on **every tool call**, in sequence, inside the dispatch: a 30s ceiling
 * there is 30s of wall clock per call before `on_failure` even applies. The long
 * budget is reserved for `pre_finalize` and `pre_delegate_task`, which fire O(1)
 * times per agent.
 *
 * `run_end` is shorter still, matching `CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS`:
 * the engine already advertises that bound for run-end work, and exceeding it
 * here would silently more than double a budget a host was told to expect.
 *
 * The schema's own `timeout_ms` description is generated from these values, so
 * the documented defaults cannot drift from the implemented ones.
 */
export const HOOK_DEFAULT_TIMEOUT_MS = {
  tool: 5_000,
  gate: 30_000,
  observer: 5_000,
  run_end: 2_000,
  context: 5_000,
} as const;

/** Hard configuration bounds: one hook fires work, and every scope/plugin can add more. */
export const MAX_HOOKS_PER_SOURCE = 64;
export const MAX_HOOKS_PER_RUN = 128;
export const MAX_HOOK_COMMAND_CHARS = 8_192;
export const MAX_HOOK_MATCH_PATTERNS = 64;
export const MAX_HOOK_PATTERN_CHARS = 2_048;
export const MAX_HOOK_TIMEOUT_MS = 60_000;

/**
 * Schema for one workspace hook entry in settings.json / a plugin manifest.
 *
 * @remarks Cross-field rules enforced by the `superRefine`: `match` is valid
 *   only for the tool events (`pre_tool_use`/`post_tool_use`) and must set
 *   `tool` and/or `args`; every `match.args` value must be a valid regular
 *   expression; and `on_failure: "deny"` is rejected on observer events (which
 *   always pass).
 */
export const hookSchema = z
  .object({
    event: z
      .enum(HOOK_EVENTS, {
        error: `hooks[].event must be one of: ${HOOK_EVENTS.join(", ")}`,
      })
      .describe(
        "Lifecycle event that triggers the hook. Gate events (pre_tool_use, " +
          "post_tool_use, pre_finalize, pre_delegate_task) fire before/around a " +
          "decision and their verdict controls the loop (deny blocks, advise annotates). " +
          "Observer events (run_start, run_end, subagent_complete, model_call_error, " +
          "budget_exhausted, user_steer) are notify-only: the command runs, its output " +
          "is ignored, and it can never block the run. " +
          'session_start fires once per run and its {"kind":"context","text":"..."} ' +
          "output is pinned into the agent's entry context, surviving compaction. " +
          'pre_compact fires before each compaction and its {"kind":"context","text":"..."} ' +
          "output is ADDED to that pass's summarization prompt — it never replaces the " +
          "prompt the agent's profile resolved.",
      ),
    match: z
      .object({
        tool: z
          .union([
            z.string().min(1).max(MAX_HOOK_PATTERN_CHARS),
            z
              .array(z.string().min(1).max(MAX_HOOK_PATTERN_CHARS))
              .min(1)
              .max(MAX_HOOK_MATCH_PATTERNS),
          ])
          .optional()
          .describe(
            "Tool name pattern(s). A pattern is an exact name (e.g. 'shell') or a glob " +
              "where '*' matches any characters (e.g. 'github.*' matches every tool of " +
              "the 'github' MCP server). An array matches when any pattern matches.",
          ),
        args: z
          .record(
            z.string().min(1).max(MAX_HOOK_PATTERN_CHARS),
            z.string().min(1).max(MAX_HOOK_PATTERN_CHARS),
          )
          .refine((value) => Object.keys(value).length <= MAX_HOOK_MATCH_PATTERNS, {
            message: `hooks[].match.args may contain at most ${MAX_HOOK_MATCH_PATTERNS} entries`,
          })
          .optional()
          .describe(
            "Argument filters: a map of argument field name to a JS regular expression " +
              "tested against that argument's value (strings directly, other values via " +
              "their JSON serialization). All entries must match. A scoping tool, not a " +
              "security boundary — use the guard to enforce bash policy.",
          ),
      })
      .strict()
      .optional()
      .describe(
        "Optional filter: restricts the hook by tool name pattern(s) and/or argument " +
          "regexes. Only valid for the tool events pre_tool_use and post_tool_use.",
      ),
    command: z
      .string()
      .min(1, "hooks[].command must be a non-empty string")
      .max(MAX_HOOK_COMMAND_CHARS)
      .describe("Shell command to execute when the hook fires."),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(MAX_HOOK_TIMEOUT_MS)
      .optional()
      .describe(
        "Milliseconds to wait for the command before it is killed and treated as a hook " +
          `failure (resolved per on_failure). Defaults to ${HOOK_DEFAULT_TIMEOUT_MS.tool} for ` +
          `the tool events, ${HOOK_DEFAULT_TIMEOUT_MS.gate} for pre_finalize and ` +
          `pre_delegate_task, ${HOOK_DEFAULT_TIMEOUT_MS.run_end} for run_end and ` +
          `${HOOK_DEFAULT_TIMEOUT_MS.observer} for every other event.`,
      ),
    on_failure: z
      .enum(["pass", "deny"], {
        error: "hooks[].on_failure must be 'pass' | 'deny'",
      })
      .optional()
      .describe(
        "What a hook failure (spawn error, non-zero exit, output that is not a verdict " +
          "JSON, or timeout) yields: 'pass' fails open and lets the event proceed " +
          "(default); 'deny' fails closed and blocks it. Only meaningful for gate " +
          "events — observer events always pass. Exit code 2 is NOT a failure: at a " +
          "gate it is a deliberate block carrying its reason on stderr, so it denies " +
          "whatever this setting says. A shell exits 2 on a syntax or usage error too, " +
          "so a broken gate hook blocks rather than passes.",
      ),
  })
  .strict()
  .superRefine((hook, ctx) => {
    if (hook.match !== undefined && !TOOL_SCOPED_EVENTS.has(hook.event)) {
      ctx.addIssue({
        code: "custom",
        path: ["match"],
        message:
          "hooks[].match is only valid for the tool events pre_tool_use and " +
          `post_tool_use, not '${hook.event}'`,
      });
    }
    if (
      hook.match !== undefined &&
      hook.match.tool === undefined &&
      hook.match.args === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["match"],
        message: "hooks[].match must set tool and/or args",
      });
    }
    for (const [field, pattern] of Object.entries(hook.match?.args ?? {})) {
      try {
        new RegExp(pattern);
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["match", "args", field],
          message: `hooks[].match.args.${field} is not a valid regular expression`,
        });
      }
    }
    if (hook.on_failure !== undefined && OFFERING_EVENT_SET.has(hook.event)) {
      ctx.addIssue({
        code: "custom",
        path: ["on_failure"],
        message:
          `hooks[].on_failure is not valid for '${hook.event}': a hook that offers text and ` +
          "fails simply contributes nothing, and can neither block nor fail the run",
      });
    } else if (hook.on_failure === "deny" && !GATE_EVENT_SET.has(hook.event)) {
      ctx.addIssue({
        code: "custom",
        path: ["on_failure"],
        message:
          `hooks[].on_failure: "deny" is only valid for gate events; '${hook.event}' ` +
          "is an observer event and always passes",
      });
    }
  })
  .describe(
    "A workspace hook: an event-triggered shell command, optionally scoped by tool " +
      "name pattern(s) and/or argument regexes (tool events only).",
  );

/** One validated workspace hook (the inferred shape of {@link hookSchema}). */
export type HookConfig = z.infer<typeof hookSchema>;
