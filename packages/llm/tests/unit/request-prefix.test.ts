import { describe, expect, it } from "bun:test";
import { SerializedPrefixWatch } from "../../src/ai-sdk/request-prefix.ts";

const transport = Object.assign(async () => new Response("{}"), { preconnect: fetch.preconnect });

describe("serialized request prefix diagnostics", () => {
  it("detects the first changed field without retaining its private contents", async () => {
    const watch = new SerializedPrefixWatch();
    const send = (body: unknown) =>
      watch.wrap(transport)("https://fixture.invalid/responses", { body: JSON.stringify(body) });
    const request = {
      prompt_cache_key: "session_agent",
      instructions: "secret instructions",
      tools: [{ name: "read" }],
      input: [{ role: "user", content: "private corpus" }],
    };
    await send(request);
    expect(watch.evidence("session_agent")).toEqual({ previousItems: 0, currentItems: 1 });
    await send({ ...request, input: [...request.input, { role: "user", content: "appended" }] });
    expect(watch.evidence("session_agent")?.divergence).toBeUndefined();
    await send(request);
    expect(watch.evidence("session_agent")?.divergence).toEqual({ surface: "history", item: 1 });
    await send({ ...request, instructions: "new instructions" });
    expect(watch.evidence("session_agent")?.divergence).toEqual({ surface: "instructions" });
    await send({ ...request, instructions: "new instructions", tools: [] });
    expect(watch.evidence("session_agent")?.divergence).toEqual({ surface: "tools" });
    expect(JSON.stringify(watch.evidence("session_agent"))).not.toContain("private");
  });

  it("bounds both retained conversations and per-conversation items", async () => {
    const watch = new SerializedPrefixWatch();
    const send = watch.wrap(transport);
    for (let index = 0; index < 33; index += 1)
      await send("https://fixture.invalid/responses", {
        body: JSON.stringify({ prompt_cache_key: `s_a${index}`, input: [] }),
      });
    expect(watch.evidence("s_a0")).toBeUndefined();
    expect(watch.evidence("s_a32")).toBeDefined();
    await send("https://fixture.invalid/responses", {
      body: JSON.stringify({
        prompt_cache_key: "s_a32",
        input: Array.from({ length: 8193 }, () => ({})),
      }),
    });
    expect(watch.evidence("s_a32")).toBeUndefined();
    await send("https://fixture.invalid/other", { body: "not JSON" });
    expect(watch.evidence(undefined)).toBeUndefined();
  });

  it("separates Chat Completions instructions from append-only conversation items", async () => {
    const watch = new SerializedPrefixWatch();
    const send = (messages: Array<{ role: string; content: string }>) =>
      watch.wrap(transport)("https://fixture.invalid/chat/completions", {
        body: JSON.stringify({ prompt_cache_key: "session_chat", messages }),
      });
    const system = { role: "system", content: "Stable instructions" };
    const user = { role: "user", content: "Initial request" };
    await send([system, user]);
    expect(watch.evidence("session_chat")).toEqual({ previousItems: 0, currentItems: 1 });
    await send([system, user, { role: "assistant", content: "Continuation" }]);
    expect(watch.evidence("session_chat")).toEqual({ previousItems: 1, currentItems: 2 });
    await send([{ ...system, content: "Changed instructions" }, user]);
    expect(watch.evidence("session_chat")?.divergence).toEqual({ surface: "instructions" });
  });
});
