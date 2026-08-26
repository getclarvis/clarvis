import { afterEach, describe, it, expect } from "bun:test";
import { createFakeRunHost } from "../helpers/fake-run-host.ts";
import { closeOpenHarnesses, makeHarness, payloadOf } from "../helpers/harness.ts";
import { TOOL_NAMES } from "../../src/mcp/tools.ts";

afterEach(closeOpenHarnesses);

const ASK = {
  id: "q1",
  kind: "ask_user" as const,
  prompt: "Which environment?",
  schema: { type: "object", properties: { answer: { type: "string" } } },
};

const GUARD = {
  id: "g1",
  kind: "guard_confirm" as const,
  prompt: "Run `rm -rf build`?",
  detail: { command: "rm -rf build", cwd: "/w", reason: "cleanup" },
};

describe("elicitation — auto_decline (the no-stall guarantee)", () => {
  it("answers every question immediately when the client cannot be asked", async () => {
    const host = createFakeRunHost(() => ({ elicits: [ASK, { ...ASK, id: "q2" }] }));
    const h = await makeHarness({ host });

    const out = payloadOf(
      await h.client.callTool({
        name: TOOL_NAMES.run,
        arguments: { prompt: "go", execution_id: "auto-1" },
      }),
    );

    expect(out.status).toBe("completed");
    expect(host.responses.map((r) => r.action)).toEqual(["decline", "decline"]);
    expect((out.posture as { auto_answered: number }).auto_answered).toBe(2);
    expect(
      h.messages.some(
        (message) => (message.data as { type?: string }).type === "elicitation_pending",
      ),
    ).toBe(true);
    await h.close();
  });

  it("denies a guard confirmation rather than leaving it hanging", async () => {
    const host = createFakeRunHost(() => ({ elicits: [GUARD] }));
    const h = await makeHarness({ host });

    const out = payloadOf(
      await h.client.callTool({ name: TOOL_NAMES.run, arguments: { prompt: "go" } }),
    );

    expect(out.status).toBe("completed");
    expect(host.responses).toEqual([{ id: "g1", action: "decline" }]);
    await h.close();
  });
});

describe("elicitation — relay", () => {
  it("forwards to a declaring client and feeds the answer back to the run", async () => {
    const host = createFakeRunHost(() => ({ elicits: [ASK] }));
    const asked: string[] = [];
    const h = await makeHarness({
      host,
      onElicit: (params) => {
        asked.push(params.message);
        return Promise.resolve({ action: "accept" as const, content: { answer: "staging" } });
      },
    });

    const out = payloadOf(
      await h.client.callTool({ name: TOOL_NAMES.run, arguments: { prompt: "go" } }),
    );

    expect(asked).toEqual(["Which environment?"]);
    expect(host.responses).toEqual([
      { id: "q1", action: "accept", content: { answer: "staging" } },
    ]);
    expect((out.posture as { elicitation: string }).elicitation).toBe("relay");
    await h.close();
  });

  it("declines when the client's handler fails, instead of stalling the run", async () => {
    const host = createFakeRunHost(() => ({ elicits: [ASK] }));
    const h = await makeHarness({
      host,
      onElicit: () => Promise.reject(new Error("client blew up")),
    });

    const out = payloadOf(
      await h.client.callTool({ name: TOOL_NAMES.run, arguments: { prompt: "go" } }),
    );

    expect(out.status).toBe("completed");
    expect(host.responses.map((r) => r.action)).toEqual(["decline"]);
    await h.close();
  });

  it("auto-denies a guard confirmation before it ever reaches the client", async () => {
    const host = createFakeRunHost(() => ({ elicits: [GUARD] }));
    let clientWasAsked = false;
    const h = await makeHarness({
      host,
      onElicit: () => {
        clientWasAsked = true;
        return Promise.resolve({ action: "accept" as const });
      },
    });

    await h.client.callTool({ name: TOOL_NAMES.run, arguments: { prompt: "go" } });

    expect(clientWasAsked).toBe(false);
    expect(host.responses).toEqual([{ id: "g1", action: "decline" }]);
    await h.close();
  });
});

describe("elicitation — await (answered by clarvis_respond)", () => {
  it("holds the question until the caller answers it on another call", async () => {
    const host = createFakeRunHost(() => ({ elicits: [ASK] }));
    const h = await makeHarness({ host });

    const pending = h.client.callTool({
      name: TOOL_NAMES.run,
      arguments: { prompt: "go", execution_id: "await-1", elicitations: "await" },
    });
    await h.waitForMessage(
      (message) => (message.data as { type?: string }).type === "elicitation_pending",
    );
    expect(host.responses).toHaveLength(0);

    const ack = payloadOf(
      await h.client.callTool({
        name: TOOL_NAMES.respond,
        arguments: {
          execution_id: "await-1",
          id: "q1",
          action: "accept",
          content: { answer: "prod" },
        },
      }),
    );
    expect(ack.accepted).toBe(true);

    const out = payloadOf(await pending);
    expect(out.status).toBe("completed");
    expect(host.responses).toEqual([{ id: "q1", action: "accept", content: { answer: "prod" } }]);
    await h.close();
  });

  it("reports an unknown id, and refuses respond on a self-answering run", async () => {
    const host = createFakeRunHost(() => ({ elicits: [ASK] }));
    const h = await makeHarness({ host });

    const pending = h.client.callTool({
      name: TOOL_NAMES.run,
      arguments: { prompt: "go", execution_id: "await-2", elicitations: "await" },
    });
    await h.waitForMessage(
      (message) => (message.data as { type?: string }).type === "elicitation_pending",
    );

    const unknown = payloadOf(
      await h.client.callTool({
        name: TOOL_NAMES.respond,
        arguments: { execution_id: "await-2", id: "nope", action: "decline" },
      }),
    );
    expect(unknown).toMatchObject({ accepted: false });
    expect(String(unknown.note)).toContain("no pending question");

    await h.client.callTool({
      name: TOOL_NAMES.respond,
      arguments: { execution_id: "await-2", id: "q1", action: "decline" },
    });
    await pending;
    await h.close();
  });
});
