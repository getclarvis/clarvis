import { describe, expect, it } from "bun:test";
import { createGoalChanges } from "../../src/goals/changes.ts";
import { recordingLogger } from "../helpers/logger.ts";

describe("goal display invalidations", () => {
  it("isolates conversations and observer faults without changing state authority", () => {
    const logger = recordingLogger();
    const changes = createGoalChanges(logger);
    const received: unknown[] = [];
    changes.subscribe("session", () => {
      throw new Error("private-observer-error");
    });
    const off = changes.subscribe("session", (value) => received.push(value));
    changes.subscribe("other", () => {
      throw new Error("Wrong conversation");
    });
    changes.notify("session");
    expect(received).toEqual([{ session_id: "session" }]);
    expect(logger.records).toHaveLength(1);
    expect(logger.events("goal.change.delivery_failed")).toEqual([
      { event: "goal.change.delivery_failed", session_id: "session" },
    ]);
    expect(JSON.stringify(logger.records)).not.toContain("private-observer-error");
    off();
    off();
    changes.notify("session");
    expect(received).toHaveLength(1);
    changes.close();
    changes.notify("session");
    expect(logger.records).toHaveLength(2);
    expect(() => changes.subscribe("session", () => {})).toThrow("closed");
  });

  it("bounds registrations and returns capacity on release", () => {
    const changes = createGoalChanges(recordingLogger());
    const subscriptions = Array.from({ length: 128 }, () => changes.subscribe("session", () => {}));
    expect(() => changes.subscribe("session", () => {})).toThrow("limit");
    subscriptions[0]!();
    expect(() => changes.subscribe("session", () => {})).not.toThrow();
    changes.close();
  });
});
