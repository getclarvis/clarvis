/**
 * A deterministic, LLM-free digest of a finished run: the compact representation
 * of the run the per-run indexer model sees (commands, errors paired with their
 * eventual fix, files touched, retries, steering).
 */
import { truncate } from "./text.ts";
import type { RunSnapshot, ToolCallEvent } from "./types.ts";

/** One shell command executed during the run, with its outcome and wall time. */
export interface DigestCommand {
  /** The command line, truncated to 300 chars. */
  command: string;
  /** Whether the invocation completed without a tool error. */
  ok: boolean;
  /** Elapsed time of the call in milliseconds, floored at 0. */
  duration_ms: number;
}

/**
 * One failed tool call, paired — when the same tool later succeeded — with the
 * arguments of that eventual success, so the indexer can learn the fix.
 */
export interface DigestError {
  /** Name of the tool that errored. */
  tool: string;
  /** The error message, truncated to 400 chars. */
  error: string;
  /** JSON excerpt of the failing call's arguments. */
  args_excerpt: string;
  /**
   * JSON excerpt of the arguments of the next successful call to the same tool,
   * if any followed; absent when the tool never recovered.
   */
  followed_by_success?: string;
}

/**
 * The deterministic, LLM-free distillation of a {@link RunSnapshot} that the
 * per-run indexer model consumes: commands run, files touched, errors paired
 * with their fix, repeated identical calls, user steering, and summary stats.
 *
 * @remarks
 * Produced by {@link buildDigest} and rendered to text by {@link renderDigest}.
 */
export interface RunDigest {
  /** Every shell command observed, in order. */
  commands: DigestCommand[];
  /** Distinct file paths referenced by any tool call's arguments, sorted. */
  files_touched: string[];
  /** Every failed tool call, each optionally paired with a later success. */
  errors: DigestError[];
  /** Tool+args signatures invoked more than once, with their repeat count. */
  retries: { key: string; count: number }[];
  /** Verbatim mid-run user steering messages, each truncated to 400 chars. */
  steering: string[];
  /** Whole-run summary counters. */
  stats: {
    status: string;
    duration_ms: number;
    tool_calls: number;
    failed_calls: number;
  };
}

const BASH_TOOLS = new Set(["shell", "bash", "exec", "execute", "run_command", "execute_command"]);
const FILE_ARG_KEYS = ["path", "file_path", "file", "target", "source", "destination"];

/**
 * The shell command string of a bash-family tool call, or null for any other
 * tool or a call whose `arguments` lack a string `command` field.
 *
 * @param event - the tool call to inspect.
 * @returns the command line, or null when the call is not a recognized shell.
 */
function commandOf(event: ToolCallEvent): string | null {
  if (!BASH_TOOLS.has(event.tool_name.toLowerCase())) return null;
  const args = event.arguments;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const command = (args as Record<string, unknown>)["command"];
    if (typeof command === "string") return command;
  }
  return null;
}

/**
 * A length-capped JSON rendering of a call's `arguments` for the digest.
 *
 * @param event - the tool call whose arguments to serialize.
 * @param max - the character cap (default 200).
 * @returns the truncated JSON, or `"{}"` when the value cannot be stringified.
 */
function argsExcerpt(event: ToolCallEvent, max = 200): string {
  try {
    return truncate(JSON.stringify(event.arguments) ?? "{}", max);
  } catch {
    return "{}";
  }
}

/**
 * Fold a finished run's tool trace into a {@link RunDigest}: extract shell
 * commands, collect referenced file paths, pair each failed call with the next
 * success of the same tool, count repeated identical calls, and tally stats.
 *
 * @param run - the finished run to summarize.
 * @returns the deterministic digest; feed it to {@link renderDigest} for text.
 * @remarks Purely derived from `run` — no LLM, no I/O — so it is stable and
 *   safe to compute on every run. `files_touched` is drawn from a fixed set of
 *   argument keys ({@link FILE_ARG_KEYS}) and sorted; `retries` keys past a
 *   count of one only.
 */
export function buildDigest(run: RunSnapshot): RunDigest {
  const commands: DigestCommand[] = [];
  const files = new Set<string>();
  const errors: DigestError[] = [];
  const callCounts = new Map<string, number>();

  for (const [i, event] of run.tool_calls.entries()) {
    const command = commandOf(event);
    if (command !== null) {
      commands.push({
        command: truncate(command, 300),
        ok: event.error === null,
        duration_ms: Math.max(0, event.ended_at - event.started_at),
      });
    }
    if (event.arguments && typeof event.arguments === "object") {
      for (const key of FILE_ARG_KEYS) {
        const value = (event.arguments as Record<string, unknown>)[key];
        if (typeof value === "string" && value.length > 0) files.add(value);
      }
    }
    const key = `${event.tool_name}\0${argsExcerpt(event, 500)}`;
    callCounts.set(key, (callCounts.get(key) ?? 0) + 1);

    if (event.error !== null) {
      const next = run.tool_calls
        .slice(i + 1)
        .find((e) => e.tool_name === event.tool_name && e.error === null);
      const entry: DigestError = {
        tool: event.tool_name,
        error: truncate(event.error, 400),
        args_excerpt: argsExcerpt(event),
      };
      if (next) entry.followed_by_success = argsExcerpt(next);
      errors.push(entry);
    }
  }

  const retries = [...callCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key: truncate(key.replace(/\s+/g, " "), 200), count }));

  return {
    commands,
    files_touched: [...files].sort(),
    errors,
    retries,
    steering: (run.steering ?? []).map((s) => truncate(s, 400)),
    stats: {
      status: run.status,
      duration_ms: Math.max(0, run.ended_at - run.started_at),
      tool_calls: run.tool_calls.length,
      failed_calls: errors.length,
    },
  };
}

/**
 * Render a {@link RunDigest} as compact markdown text, hard-capped at
 * `maxChars`. Sections are emitted in priority order — stats, errors, steering,
 * commands, retries, files — so truncation drops the least valuable content
 * first.
 *
 * @param digest - the digest to render, from {@link buildDigest}.
 * @param maxChars - the hard character cap on the returned text.
 * @returns the truncated markdown block fed to the indexer prompt.
 */
export function renderDigest(digest: RunDigest, maxChars: number): string {
  const sections: string[] = [];
  const s = digest.stats;
  sections.push(
    `## Stats\nstatus=${s.status} duration_ms=${s.duration_ms} tool_calls=${s.tool_calls} failed=${s.failed_calls}`,
  );
  if (digest.errors.length > 0) {
    sections.push(
      "## Errors (error → what eventually worked, if anything)\n" +
        digest.errors
          .map(
            (e) =>
              `- [${e.tool}] ${e.error}\n  args: ${e.args_excerpt}` +
              (e.followed_by_success ? `\n  later success with: ${e.followed_by_success}` : ""),
          )
          .join("\n"),
    );
  }
  if (digest.steering.length > 0) {
    sections.push(
      "## User steering (verbatim)\n" + digest.steering.map((m) => `- ${m}`).join("\n"),
    );
  }
  if (digest.commands.length > 0) {
    sections.push(
      "## Commands\n" +
        digest.commands
          .map((c) => `- ${c.ok ? "ok " : "ERR"} (${c.duration_ms}ms) ${c.command}`)
          .join("\n"),
    );
  }
  if (digest.retries.length > 0) {
    sections.push(
      "## Repeated identical calls\n" +
        digest.retries.map((r) => `- x${r.count} ${r.key}`).join("\n"),
    );
  }
  if (digest.files_touched.length > 0) {
    sections.push("## Files touched\n" + digest.files_touched.map((f) => `- ${f}`).join("\n"));
  }
  return truncate(sections.join("\n\n"), maxChars);
}
