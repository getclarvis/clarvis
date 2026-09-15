import {
  createLoopCalendar,
  loopInterval,
  loopTimezone,
  type LoopSchedule,
} from "../../core/loop-schedule.ts";

/** Maximum retained UTF-8 prompt payload per job; registration never starts a model call. */
export const LOOP_PROMPT_MAX_BYTES = 64 * 1024;

/** The explicit user command, before any host/session effect. */
export type LoopCommand =
  | { kind: "list" }
  | { kind: "create"; schedule: LoopSchedule; prompt: string; maxRuns: number }
  | { kind: "show" | "pause" | "resume"; id: string }
  | { kind: "cancel"; id: string; running: boolean };

/** Validate the slash dialect without shell expansion, evaluation, or interpreting prompt content. */
export function parseLoopCommand(raw: string, defaultTimezone?: string): LoopCommand {
  if (raw.length > LOOP_PROMPT_MAX_BYTES + 1024) throw new Error("Loop command is too long.");
  let cursor = 0;
  const skip = (): void => {
    while (/\s/u.test(raw[cursor] ?? "") && cursor < raw.length) cursor += 1;
  };
  const token = (): string => {
    skip();
    const start = cursor;
    while (cursor < raw.length && !/\s/u.test(raw[cursor]!)) cursor += 1;
    return raw.slice(start, cursor);
  };
  const first = token();
  if (first === "" || first === "list") {
    if (token() !== "") throw new Error("Usage: /loop list");
    return { kind: "list" };
  }
  if (["show", "pause", "resume", "cancel"].includes(first)) {
    const id = token();
    const option = token();
    if (!id || (option !== "" && !(first === "cancel" && option === "--running")) || token() !== "")
      throw new Error(`Usage: /loop ${first} <id>${first === "cancel" ? " [--running]" : ""}`);
    return first === "cancel"
      ? { kind: first, id, running: option === "--running" }
      : { kind: first as "show" | "pause" | "resume", id };
  }
  let expression: string | undefined;
  let interval: LoopSchedule | undefined;
  if (first === "cron") {
    skip();
    const quote = raw[cursor++];
    if (quote !== '"' && quote !== "'")
      throw new Error("Put the five-field cron expression in quotes.");
    expression = "";
    let closed = false;
    while (cursor < raw.length) {
      const char = raw[cursor++]!;
      if (char === quote) {
        closed = true;
        break;
      }
      if (char === "\\") {
        const escaped = raw[cursor++];
        if (escaped !== quote && escaped !== "\\")
          throw new Error("Inside cron quotes, escape only the matching quote or backslash.");
        expression += escaped;
      } else expression += char;
    }
    if (!closed || (cursor < raw.length && !/\s/u.test(raw[cursor]!)))
      throw new Error("Close the cron quote and separate it from the prompt with whitespace.");
  } else interval = loopInterval(first);

  let maxRuns = 20;
  let timezone = defaultTimezone;
  const seen = new Set<string>();
  let prompt: string;
  const promptStart = cursor < raw.length ? cursor + 1 : cursor;
  skip();
  if (raw.startsWith("--", cursor)) {
    while (true) {
      const option = token();
      if (option === "--") {
        prompt = raw.slice(cursor < raw.length ? cursor + 1 : cursor);
        break;
      }
      if (!option) throw new Error("Put -- between loop options and the prompt.");
      if (seen.has(option)) throw new Error(`Duplicate option: ${option}`);
      seen.add(option);
      const value = token();
      if (option === "--max-runs") {
        maxRuns = Number(value);
        if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(maxRuns))
          throw new Error("--max-runs requires a positive safe integer.");
      } else if (option === "--tz" && expression !== undefined) {
        if (!value) throw new Error("--tz requires an IANA timezone.");
        timezone = value;
      } else throw new Error(`Unknown loop option: ${option}`);
    }
  } else prompt = raw.slice(promptStart);
  if (!prompt.trim()) throw new Error("A prompt is required. Usage: /loop 5m <prompt>");
  if (new TextEncoder().encode(prompt).byteLength > LOOP_PROMPT_MAX_BYTES)
    throw new Error("A scheduled prompt may contain at most 64 KiB of UTF-8 text.");
  const schedule: LoopSchedule =
    expression === undefined
      ? interval!
      : {
          kind: "cron",
          expression: expression.trim().replace(/\s+/gu, " "),
          timezone: loopTimezone(timezone),
        };
  if (schedule.kind === "cron") {
    const calendar = createLoopCalendar(schedule.expression, schedule.timezone);
    if (calendar.next(Date.now()) === null) throw new Error("Cron has no future occurrence.");
  }
  return { kind: "create", schedule, prompt, maxRuns };
}
