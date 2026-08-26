import { afterEach, describe, expect, it } from "bun:test";
import { createFakeRunHost } from "../helpers/fake-run-host.ts";
import {
  closeOpenHarnesses,
  makeHarness,
  payloadOf,
  recordingLoggers,
} from "../helpers/harness.ts";
import { TOOL_NAMES } from "../../src/mcp/tools.ts";

afterEach(closeOpenHarnesses);

describe("what one run records", () => {
  it("reports the run starting and finishing, with the accounting the caller also gets", async () => {
    const logs = recordingLoggers();
    const host = createFakeRunHost(() => ({
      events: [{ type: "run_started", at: 1 }],
      result: {
        result: "all done",
        usage: { iterations: 3, elapsed_ms: 12, input_tokens: 100, output_tokens: 7 },
      },
    }));
    const h = await makeHarness({ host, loggers: logs.loggers });

    const out = payloadOf(
      await h.client.callTool({
        name: TOOL_NAMES.run,
        arguments: { prompt: "do it", agent: "solo", execution_id: "run-a" },
      }),
    );
    expect(out.status).toBe("completed");

    const started = logs.one("run.started");
    expect(started.level).toBe("info");
    expect(started.fields).toMatchObject({
      execution_id: "run-a",
      agent: "solo",
      elicitation_posture: "auto_decline",
    });

    const finished = logs.one("run.finished");
    expect(finished.fields).toMatchObject({
      execution_id: "run-a",
      status: "completed",
      usage_iterations: 3,
      usage_input_tokens: 100,
      usage_output_tokens: 7,
      events_dropped: 0,
      wedged: false,
      truncated: false,
    });
    expect(finished.fields.cancelled_by).toBeUndefined();
    await h.close();
  });

  it("reports every posture the facade had to weaken, and nothing when it weakened none", async () => {
    const logs = recordingLoggers();
    const host = createFakeRunHost(() => ({ result: { result: "ok" } }));
    const h = await makeHarness({ host, loggers: logs.loggers });

    await h.client.callTool({
      name: TOOL_NAMES.run,
      arguments: { prompt: "p", execution_id: "run-d", plans: "review" },
    });

    const record = logs.one("run.posture.downgraded");
    expect(record.fields.execution_id).toBe("run-d");
    expect(String(record.fields.downgrades)).toContain("plans:review→on");
    await h.close();
  });

  it("reports a cancellation, which otherwise survives only in an envelope nobody may receive", async () => {
    const logs = recordingLoggers();
    let release!: () => void;
    const holdUntil = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = createFakeRunHost(() => ({ holdUntil }));
    const h = await makeHarness({ host, loggers: logs.loggers });

    const call = h.client.callTool({
      name: TOOL_NAMES.run,
      arguments: { prompt: "p", execution_id: "run-c" },
    });
    await host.waitForStart("run-c");
    expect(h.bundle.cancelAll("session_close")).toBe(1);
    release();
    await call.catch(() => undefined);

    const record = logs.one("run.cancelled");
    expect(record.level).toBe("warn");
    expect(record.fields).toMatchObject({
      execution_id: "run-c",
      cancelled_by: "session_close",
    });
    expect(Number(record.fields.elapsed_ms)).toBeGreaterThanOrEqual(0);
    await h.close();
  });
});
