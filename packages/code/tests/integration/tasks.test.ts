import { afterEach, expect, spyOn, test } from "bun:test";
import { detachObserved } from "../../src/core/tasks.ts";
import {
  installDiagnosticSession,
  type DiagnosticDetails,
  type DiagnosticLevel,
  type DiagnosticSession,
} from "../../src/core/diagnostic-events.ts";

interface Recorded {
  event: string;
  details?: DiagnosticDetails;
  level?: DiagnosticLevel;
}

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

function recordDiagnostics(): Recorded[] {
  const records: Recorded[] = [];
  const session: DiagnosticSession = {
    path: "/dev/null",
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    level: "debug",
    setLevel: () => {},
    bind: () => {},
    event: (event, details, level) => {
      records.push({ event, details, level });
    },
    count: (event, details) => {
      records.push({ event, details });
    },
    close: () => {},
  };
  uninstall = installDiagnosticSession(session);
  return records;
}

test("detached tasks route synchronous and asynchronous failures through their local observer", async () => {
  const observed: unknown[] = [];
  const synchronous = new Error("synchronous failure");
  const asynchronous = new Error("asynchronous failure");

  detachObserved(
    "synchronous",
    () => {
      throw synchronous;
    },
    (error) => observed.push(error),
  );
  detachObserved(
    "asynchronous",
    () => Promise.reject(asynchronous),
    (error) => observed.push(error),
  );
  await Promise.resolve();

  expect(observed).toEqual([synchronous, asynchronous]);
});

test("every failure is recorded before the local observer runs", () => {
  const records = recordDiagnostics();
  const failure = new Error("background failure");
  const seen: unknown[] = [];

  detachObserved(
    "recorded",
    () => {
      throw failure;
    },
    (error) => seen.push(error),
  );

  expect(records).toEqual([
    {
      event: "task.failed",
      details: { operation: "recorded", error: failure, observed: true },
      level: "error",
    },
  ]);
  expect(seen).toEqual([failure]);
});

test("a failure with no local observer is still recorded, and marked as unobserved", () => {
  const records = recordDiagnostics();
  const failure = new Error("unobserved failure");

  detachObserved("unobserved", () => {
    throw failure;
  });

  expect(records).toEqual([
    {
      event: "task.failed",
      details: { operation: "unobserved", error: failure, observed: false },
      level: "error",
    },
  ]);
});

test("a broken local observer is recorded rather than escalated to the process", () => {
  const records = recordDiagnostics();
  const warning = spyOn(process, "emitWarning").mockImplementation(() => undefined);
  const observerError = new Error("observer failure");
  try {
    detachObserved(
      "observer_failure",
      () => {
        throw new Error("background failure");
      },
      () => {
        throw observerError;
      },
    );

    expect(records.map((r) => r.event)).toEqual(["task.failed", "task.observer_failed"]);
    expect(records[1]?.details).toEqual({ operation: "observer_failure", error: observerError });
    expect(warning).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});

test("nothing reaches the process warning channel, which would paint over the renderer", () => {
  const warning = spyOn(process, "emitWarning").mockImplementation(() => undefined);
  try {
    detachObserved("no_session", () => {
      throw new Error("failure with no diagnostic session installed");
    });
    expect(warning).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});
