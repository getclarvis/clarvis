import { afterEach, describe, expect, it } from "bun:test";
import { NOOP_LOGGER } from "@clarvis/capability";
import { observeServerTask, setServerTaskObserver } from "../../src/tasks.ts";
import { recordingLoggers } from "../helpers/harness.ts";

afterEach(() => {
  setServerTaskObserver(NOOP_LOGGER);
});

/** Wait until `read` reports something, or give up. */
async function settle(read: () => number): Promise<void> {
  for (let attempt = 0; attempt < 50 && read() === 0; attempt += 1) await Bun.sleep(1);
}

describe("observeServerTask", () => {
  it("reports a detached failure to the installed logger rather than to stderr", async () => {
    const logs = recordingLoggers();
    setServerTaskObserver(logs.loggers.log);

    observeServerTask(`server_task_${Math.random().toString(36).slice(2)}`, () => {
      throw new Error("the detached work blew up");
    });
    await settle(() => logs.find("task.failed").length);

    const record = logs.one("task.failed");
    expect(record.level).toBe("warn");
    expect(record.fields.err).toContain("the detached work blew up");
    expect(String(record.fields.operation)).toStartWith("server_task_");
  });

  it("stays silent while no host has installed one", async () => {
    const logs = recordingLoggers();
    observeServerTask(`server_task_${Math.random().toString(36).slice(2)}`, () => {
      throw new Error("nobody is listening");
    });
    await Bun.sleep(5);
    expect(logs.records).toHaveLength(0);
  });

  it("does not report a task that succeeded", async () => {
    const logs = recordingLoggers();
    setServerTaskObserver(logs.loggers.log);
    observeServerTask("server_task_ok", () => Promise.resolve(1));
    await Bun.sleep(5);
    expect(logs.find("task.failed")).toHaveLength(0);
  });
});
