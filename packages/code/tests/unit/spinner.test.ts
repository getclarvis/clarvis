import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  charForFrame,
  formatElapsed,
  spinnerChar,
  SPINNER_ASCII,
  SPINNER_FRAMES,
  tickNow,
  useSpinnerClock,
} from "../../src/views/spinner.ts";

function fakeClock(): {
  clock: Parameters<typeof useSpinnerClock>[1];
  tick(): void;
  intervals: number[];
  cancellations(): number;
} {
  let callback: (() => void) | undefined;
  let cancellations = 0;
  const intervals: number[] = [];
  return {
    clock: {
      every(fn, intervalMs) {
        callback = fn;
        intervals.push(intervalMs);
        return () => {
          callback = undefined;
          cancellations++;
        };
      },
    },
    tick: () => callback?.(),
    intervals,
    cancellations: () => cancellations,
  };
}

test("charForFrame cycles the frames and wraps", () => {
  expect(charForFrame(0)).toBe(SPINNER_FRAMES[0]!);
  expect(charForFrame(1)).toBe(SPINNER_FRAMES[1]!);
  expect(charForFrame(SPINNER_FRAMES.length)).toBe(SPINNER_FRAMES[0]!);
  expect(charForFrame(SPINNER_FRAMES.length + 1)).toBe(SPINNER_FRAMES[1]!);
  expect(charForFrame(-1)).toBe(SPINNER_FRAMES[SPINNER_FRAMES.length - 1]!);
});

test("charForFrame honours the ascii fallback", () => {
  expect(charForFrame(0, true)).toBe(SPINNER_ASCII[0]);
  expect(charForFrame(SPINNER_ASCII.length, true)).toBe(SPINNER_ASCII[0]);
  expect(SPINNER_ASCII).not.toContain("@");
  expect(SPINNER_ASCII).not.toContain("O");
});

test("formatElapsed renders seconds then minutes:seconds, clamped at zero", () => {
  expect(formatElapsed(0)).toBe("0s");
  expect(formatElapsed(3200)).toBe("3s");
  expect(formatElapsed(59_000)).toBe("59s");
  expect(formatElapsed(60_000)).toBe("1m00s");
  expect(formatElapsed(62_000)).toBe("1m02s");
  expect(formatElapsed(3_723_000)).toBe("62m03s");
  expect(formatElapsed(-500)).toBe("0s");
});

test("tickNow reads the shared frame clock and returns the current time", () => {
  const before = Date.now();
  const t = tickNow();
  const after = Date.now();
  expect(t).toBeGreaterThanOrEqual(before);
  expect(t).toBeLessThanOrEqual(after);
});

test("useSpinnerClock: while active, the shared frame advances on a clock tick", () => {
  const fake = fakeClock();
  const dispose = createRoot((d) => {
    useSpinnerClock(() => true, fake.clock);
    return d;
  });
  try {
    const before = spinnerChar();
    fake.tick();
    expect(spinnerChar()).not.toBe(before);
  } finally {
    dispose();
  }
});

test("useSpinnerClock: active schedules 200ms ticks and disposal cancels its clock", () => {
  const fake = fakeClock();
  const dispose = createRoot((d) => {
    useSpinnerClock(() => true, fake.clock);
    return d;
  });
  try {
    expect(fake.intervals).toEqual([200]);
    expect(fake.cancellations()).toBe(0);
  } finally {
    dispose();
  }
  expect(fake.cancellations()).toBe(1);
});

test("useSpinnerClock: inactive never starts a timer (the effect returns immediately)", () => {
  const fake = fakeClock();
  const dispose = createRoot((d) => {
    useSpinnerClock(() => false, fake.clock);
    return d;
  });
  try {
    expect(fake.intervals).toEqual([]);
  } finally {
    dispose();
  }
  expect(fake.cancellations()).toBe(0);
});

test("useSpinnerClock: the default clock can be torn down immediately without leaving a tick", () => {
  const before = spinnerChar();
  const dispose = createRoot((d) => {
    useSpinnerClock(() => true);
    return d;
  });
  dispose();
  expect(spinnerChar()).toBe(before);
});
