import { beforeEach, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createHintState } from "../../src/views/hint.ts";

type TimerCall = { fn: () => void; ms: number; id: number };

let scheduled: TimerCall[] = [];
let cleared: number[] = [];
let nextId = 1;
const clock: Parameters<typeof createHintState>[0] = {
  after(fn, ms) {
    const id = nextId++;
    scheduled.push({ fn, ms, id });
    return () => cleared.push(id);
  },
};

beforeEach(() => {
  scheduled = [];
  cleared = [];
  nextId = 1;
});

test("starts with an empty info hint", () => {
  const dispose = createRoot((d) => {
    const { hint } = createHintState(clock);
    expect(hint()).toEqual({ text: "", tone: "info" });
    return d;
  });
  dispose();
});

test("notify sets the hint text/tone and schedules a 4s auto-clear timer", () => {
  const dispose = createRoot((d) => {
    const { hint, notify } = createHintState(clock);
    notify("saved", "success");
    expect(hint()).toEqual({ text: "saved", tone: "success" });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(4000);
    expect(cleared).toHaveLength(0);
    return d;
  });
  dispose();
});

test("notify defaults tone to 'info' when omitted", () => {
  const dispose = createRoot((d) => {
    const { hint, notify } = createHintState(clock);
    notify("just a message");
    expect(hint()).toEqual({ text: "just a message", tone: "info" });
    return d;
  });
  dispose();
});

test("the scheduled timer clears the hint back to empty/info when it fires", () => {
  const dispose = createRoot((d) => {
    const { hint, notify } = createHintState(clock);
    notify("warn me", "warn");
    expect(hint()).toEqual({ text: "warn me", tone: "warn" });
    scheduled[0]!.fn();
    expect(hint()).toEqual({ text: "", tone: "info" });
    return d;
  });
  dispose();
});

test("a second notify before the first timer fires clears the stale timer and schedules a new one", () => {
  const dispose = createRoot((d) => {
    const { hint, notify } = createHintState(clock);
    notify("first", "warn");
    const firstId = scheduled[0]!.id;
    notify("second", "error");
    expect(hint()).toEqual({ text: "second", tone: "error" });
    expect(cleared).toEqual([firstId]);
    expect(scheduled).toHaveLength(2);
    return d;
  });
  dispose();
});

test("notify with an empty message clears any pending timer and does not schedule a new one", () => {
  const dispose = createRoot((d) => {
    const { hint, notify } = createHintState(clock);
    notify("something", "warn");
    const firstId = scheduled[0]!.id;
    notify("");
    expect(hint()).toEqual({ text: "", tone: "info" });
    expect(cleared).toEqual([firstId]);
    expect(scheduled).toHaveLength(1);
    return d;
  });
  dispose();
});

test("notify with an empty message on a fresh hint state schedules nothing and clears nothing", () => {
  const dispose = createRoot((d) => {
    const { hint, notify } = createHintState(clock);
    notify("");
    expect(hint()).toEqual({ text: "", tone: "info" });
    expect(scheduled).toHaveLength(0);
    expect(cleared).toHaveLength(0);
    return d;
  });
  dispose();
});

test("the default clock is synchronously cancelled when its owner is disposed", () => {
  const dispose = createRoot((d) => {
    const { hint, notify } = createHintState();
    notify("short-lived");
    expect(hint().text).toBe("short-lived");
    return d;
  });
  expect(dispose).not.toThrow();
});
