import { afterEach, describe, it, expect } from "bun:test";
import { createFakeRunHost } from "../helpers/fake-run-host.ts";
import { closeOpenHarnesses, makeHarness, payloadOf } from "../helpers/harness.ts";
import { TOOL_NAMES } from "../../src/mcp/tools.ts";
import { handleRespondTool } from "../../src/mcp/control-tools.ts";

afterEach(closeOpenHarnesses);

/** Start a run that stays pending until the returned `release` is called. */
async function heldRun(executionId: string) {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const host = createFakeRunHost(() => ({ holdUntil: held }));
  const h = await makeHarness({ host });
  const pending = h.client.callTool({
    name: TOOL_NAMES.run,
    arguments: { prompt: "go", execution_id: executionId },
  });
  await h.waitForMessage(
    (message) =>
      (message.data as { type?: string; execution_id?: string }).type === "run_accepted" &&
      (message.data as { execution_id?: string }).execution_id === executionId,
  );
  return { host, h, pending, release };
}

describe("control tools", () => {
  it("maps a direct response against an unknown run to not_found", async () => {
    const h = await makeHarness({ host: createFakeRunHost(() => ({})) });

    const result = handleRespondTool(
      { execution_id: "missing", id: "question", action: "decline" },
      h.bundle.runs,
    );

    expect(result.isError).toBeTrue();
    expect(payloadOf(result)).toMatchObject({ error: { code: "not_found" } });
    await h.close();
  });

  it("steers a run while its clarvis_run call is still pending", async () => {
    const { host, h, pending, release } = await heldRun("run-1");

    const ack = payloadOf(
      await h.client.callTool({
        name: TOOL_NAMES.steer,
        arguments: { execution_id: "run-1", message: "actually, do the other thing" },
      }),
    );
    expect(ack).toMatchObject({ execution_id: "run-1", accepted: true });
    expect(host.steers).toEqual(["actually, do the other thing"]);

    release();
    expect(payloadOf(await pending).status).toBe("completed");
    await h.close();
  });

  it("cancels a pending run and still answers the run call", async () => {
    const { host, h, pending, release } = await heldRun("run-2");

    const ack = payloadOf(
      await h.client.callTool({ name: TOOL_NAMES.cancel, arguments: { execution_id: "run-2" } }),
    );
    expect(ack).toMatchObject({ accepted: true });
    expect(host.cancels).toEqual(["run-2"]);

    release();
    expect(payloadOf(await pending).execution_id).toBe("run-2");
    await h.close();
  });

  it("reports not_found for an unknown run, and after the run has settled", async () => {
    const host = createFakeRunHost(() => ({}));
    const h = await makeHarness({ host });

    const unknown = await h.client.callTool({
      name: TOOL_NAMES.steer,
      arguments: { execution_id: "nope", message: "hi" },
    });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(payloadOf(unknown))).toContain("not_found");

    await h.client.callTool({
      name: TOOL_NAMES.run,
      arguments: { prompt: "go", execution_id: "run-3" },
    });
    const settled = await h.client.callTool({
      name: TOOL_NAMES.cancel,
      arguments: { execution_id: "run-3" },
    });
    expect(settled.isError).toBe(true);
    await h.close();
  });

  it("a second session cannot reach the first session's run", async () => {
    const { h, pending, release } = await heldRun("run-4");
    const other = await makeHarness({ host: createFakeRunHost(() => ({})) });

    const cross = await other.client.callTool({
      name: TOOL_NAMES.steer,
      arguments: { execution_id: "run-4", message: "leak?" },
    });
    expect(cross.isError).toBe(true);
    expect(JSON.stringify(payloadOf(cross))).toContain("not_found");

    release();
    await pending;
    await h.close();
    await other.close();
  });

  it("rejects a duplicate execution_id instead of starting a second run", async () => {
    const { host, h, pending, release } = await heldRun("run-5");

    const dup = await h.client.callTool({
      name: TOOL_NAMES.run,
      arguments: { prompt: "again", execution_id: "run-5" },
    });
    expect(dup.isError).toBe(true);
    expect(JSON.stringify(payloadOf(dup))).toContain("conflict");
    expect(host.started).toHaveLength(1);

    release();
    await pending;
    await h.close();
  });
});
