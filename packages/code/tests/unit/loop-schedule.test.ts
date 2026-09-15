import { describe, expect, test } from "bun:test";
import {
  createLoopCalendar,
  loopInterval,
  loopScheduleLabel,
  loopTimezone,
} from "../../src/core/loop-schedule.ts";
import { parseLoopCommand } from "../../src/features/loop/parser.ts";

const at = (iso: string): number => Date.parse(iso);
const iso = (time: number | null): string | null =>
  time === null ? null : new Date(time).toISOString();

describe("loop command syntax", () => {
  test("keeps duration units and literal prompt content, including whitespace and dispatcher-looking text", () => {
    for (const [duration, everyMs] of [
      ["1m", 60_000],
      ["90m", 5_400_000],
      ["2h", 7_200_000],
      ["1d", 86_400_000],
    ] as const) {
      const command = parseLoopCommand(`${duration} check PR 123`);
      expect(command).toEqual({
        kind: "create",
        schedule: { kind: "interval", everyMs, basis: "after-completion" },
        prompt: "check PR 123",
        maxRuns: 20,
      });
    }
    for (const prompt of [
      "/quit",
      "/loop 1m recurse",
      "!touch sentinel",
      "prompt 123",
      "  spaces\n  and lines  ",
      "$(touch sentinel) `code` $HOME",
    ]) {
      expect(parseLoopCommand(`5m --max-runs 8 -- ${prompt}`)).toMatchObject({
        prompt,
        maxRuns: 8,
      });
    }
    expect(parseLoopCommand("5m  two spaces  ")).toMatchObject({ prompt: " two spaces  " });
  });

  test("registers cron with an explicit resolved timezone and does not parse options out of the prompt", () => {
    expect(
      parseLoopCommand('cron "0 9 * * 1-5" --tz America/Recife -- prepare --max-runs 99  '),
    ).toMatchObject({
      schedule: { kind: "cron", expression: "0 9 * * 1-5", timezone: "America/Recife" },
      prompt: "prepare --max-runs 99  ",
      maxRuns: 20,
    });
    expect(parseLoopCommand("cron '*/5 * * * *' inspect", "UTC")).toMatchObject({
      schedule: { timezone: "UTC" },
    });
    expect(parseLoopCommand("1m inspect --tz arbitrary")).toMatchObject({
      prompt: "inspect --tz arbitrary",
    });
  });

  test("lists and controls without fabricating a maintenance prompt", () => {
    expect(parseLoopCommand("")).toEqual({ kind: "list" });
    expect(parseLoopCommand("list")).toEqual({ kind: "list" });
    for (const kind of ["show", "pause", "resume"] as const)
      expect(parseLoopCommand(`${kind} loop_1`)).toEqual({ kind, id: "loop_1" });
    expect(parseLoopCommand("cancel loop_1")).toEqual({
      kind: "cancel",
      id: "loop_1",
      running: false,
    });
    expect(parseLoopCommand("cancel loop_1 --running")).toEqual({
      kind: "cancel",
      id: "loop_1",
      running: true,
    });
  });

  test.each([
    "5",
    "0m x",
    "-1m x",
    "1.5h x",
    "1s x",
    "9007199254740991d x",
    "5m",
    "5m --  ",
    "5m --max-runs 0 -- x",
    "5m --max-runs 1.5 -- x",
    "5m --max-runs 9007199254740992 -- x",
    "5m --max-runs 2 x",
    "5m --max-runs 2 --max-runs 3 -- x",
    "5m --tz UTC -- x",
    "5m --wat x -- x",
    "list x",
    "show",
    "pause loop_1 x",
    "cancel loop_1 --running x",
    "cron * * * * * x",
    'cron "* * * * * x',
    'cron "* * * * *"x',
    'cron "* * * * *" --tz Nowhere/Invalid -- x',
    'cron "* * * * *" --tz +03:00 -- x',
    'cron "* * * * *" --max-runs 1 --',
    'cron "0 0 31 2 *" x',
  ])("rejects an invalid or incomplete registration: %s", (input) => {
    expect(() => parseLoopCommand(input)).toThrow();
  });

  test("bounds retained UTF-8 prompt bytes", () => {
    expect(() => parseLoopCommand(`1m ${"é".repeat(32769)}`)).toThrow("64 KiB");
  });
});

describe("loop calendar", () => {
  test("keeps intervals different from calendar minute steps", () => {
    expect(loopScheduleLabel(loopInterval("90m"))).toBe("90 minutes after each execution");
    const calendar = createLoopCalendar("*/7 * * * *", "UTC");
    expect(iso(calendar.next(at("2026-09-08T10:56:00Z")))).toBe("2026-09-08T11:00:00.000Z");
  });

  test("coalesces to the latest actual minute, including a tick just before the next minute", () => {
    const calendar = createLoopCalendar("*/5 * * * *", "UTC");
    expect(iso(calendar.latest(at("2026-09-08T10:16:00Z")))).toBe("2026-09-08T10:15:00.000Z");
    expect(iso(calendar.latest(at("2026-09-08T10:15:00Z")))).toBe("2026-09-08T10:15:00.000Z");
    expect(iso(calendar.latest(at("2026-09-08T10:14:59.999Z")))).toBe("2026-09-08T10:10:00.000Z");
  });

  test("normalizes numeric starts, wildcard and range steps without widening the product dialect", () => {
    const numeric = createLoopCalendar("5/10 * * * *", "UTC");
    expect(iso(numeric.next(at("2026-09-08T10:06:00Z")))).toBe("2026-09-08T10:15:00.000Z");
    expect(iso(numeric.latest(at("2026-09-08T10:54:00Z")))).toBe("2026-09-08T10:45:00.000Z");
    const steppedSunday = createLoopCalendar("0 9 * * */8", "UTC");
    expect(iso(steppedSunday.next(at("2026-09-05T00:00:00Z")))).toBe("2026-09-06T09:00:00.000Z");
    const range = createLoopCalendar("5-35/10 * * * *", "UTC");
    expect(iso(range.next(at("2026-09-08T10:35:00Z")))).toBe("2026-09-08T11:05:00.000Z");
  });

  test("uses OR for restricted month-day and weekday and accepts Sunday 0/7", () => {
    const calendar = createLoopCalendar("0 9 1 * 1", "UTC");
    expect(iso(calendar.next(at("2026-09-02T00:00:00Z")))).toBe("2026-09-07T09:00:00.000Z");
    expect(iso(calendar.next(at("2026-09-30T00:00:00Z")))).toBe("2026-10-01T09:00:00.000Z");
    for (const sunday of [0, 7])
      expect(
        iso(createLoopCalendar(`0 9 * * ${sunday}`, "UTC").next(at("2026-09-05T00:00:00Z"))),
      ).toBe("2026-09-06T09:00:00.000Z");
  });

  test("skips nonexistent DST times and fires only the first repeated wall time", () => {
    const gap = createLoopCalendar("30 2 * * *", "America/New_York");
    expect(iso(gap.next(at("2026-03-08T05:00:00Z")))).toBe("2026-03-09T06:30:00.000Z");
    expect(iso(gap.latest(at("2026-03-08T08:45:00Z")))).toBe("2026-03-07T07:30:00.000Z");
    const fold = createLoopCalendar("30 1 * * *", "America/New_York");
    expect(iso(fold.next(at("2026-11-01T04:00:00Z")))).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(fold.next(at("2026-11-01T05:30:00Z")))).toBe("2026-11-02T06:30:00.000Z");
    expect(iso(fold.latest(at("2026-11-01T06:45:00Z")))).toBe("2026-11-01T05:30:00.000Z");
  });

  test.each([
    "* * * * * *",
    "@hourly",
    "0 0 * JAN MON",
    "0 0 L * *",
    "0 0 ? * *",
    "0 0 * * 1#2",
    "0 0 * * +1",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "*/0 * * * *",
    "9-2 * * * *",
    "1,,2 * * * *",
  ])("rejects wider or malformed cron syntax: %s", (expression) => {
    expect(() => createLoopCalendar(expression, "UTC")).toThrow();
  });

  test("keeps the timezone captured at creation", () => {
    const timezone = loopTimezone("America/Recife");
    expect(iso(createLoopCalendar("0 9 * * *", timezone).next(at("2026-09-08T00:00:00Z")))).toBe(
      "2026-09-08T12:00:00.000Z",
    );
  });

  test("non-hour DST transitions also skip gaps and select the first repeated minute", () => {
    const fold = createLoopCalendar("30 1 * * *", "Australia/Lord_Howe");
    expect(iso(fold.next(at("2026-04-04T14:00:00Z")))).toBe("2026-04-04T14:30:00.000Z");
    expect(iso(fold.next(at("2026-04-04T14:30:00Z")))).toBe("2026-04-05T15:00:00.000Z");
    expect(iso(fold.latest(at("2026-04-04T15:15:00Z")))).toBe("2026-04-04T14:30:00.000Z");
    const gap = createLoopCalendar("15 2 * * *", "Australia/Lord_Howe");
    expect(iso(gap.next(at("2026-10-03T14:00:00Z")))).toBe("2026-10-04T15:15:00.000Z");
  });
});
