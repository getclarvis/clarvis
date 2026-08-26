import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "bun:test";
import { loadEnv } from "@clarvis/capability";
import { createConnectionManager, defaultMCPClientFactory } from "@clarvis/mcp-client";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import { MAX_TRACE_LIST_LIMIT, MAX_TRACE_LIST_OFFSET } from "@clarvis/trace";
import { MockLLM, type MockLLMScriptStep } from "@clarvis/loop/testing";
import { createAgentToolsCapability } from "@clarvis/loop/capabilities/tools";
import { createAskUserCapability, type ExecuteRunDeps } from "@clarvis/loop";
import type { RunEvent, StartRunParams } from "@clarvis/protocol";
import { createInProcessKernel } from "../../src/index.ts";
import { createMemoryConfigStore } from "../../src/config.ts";
import { kernelIdentity } from "../helpers/kernel-identity.ts";

const PROVIDERS = [
  { name: "anthropic", kind: "anthropic" },
  { name: "openai", kind: "openai" },
  { name: "google", kind: "google" },
];

function seededConfig() {
  return createMemoryConfigStore({
    settings: { workspace: { providers: PROVIDERS, default_model: "anthropic/x" } },
    agents: [
      {
        name: "solo",
        scope: "workspace",
        frontmatter: { model: "anthropic/x", tools: [] },
        body: "You are solo.",
        model: "anthropic/x",
      },
      {
        name: "sysop",
        scope: "workspace",
        frontmatter: { model: "anthropic/x", tools: [], grants: ["run_commands"] },
        body: "You run commands.",
        model: "anthropic/x",
      },
    ],
  });
}

function buildDeps(workspaceRoot: string, script?: MockLLMScriptStep[]): ExecuteRunDeps {
  const env = loadEnv({
    CLARVIS_LOG_LEVEL: "silent",
    CLARVIS_MCP_CONNECT_TIMEOUT_MS: "2000",
    CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec",
  });
  return {
    env,
    llm: new MockLLM({ script: script ?? [{ text: "Done." }] }),
    connections: createConnectionManager({
      workspace: workspaceRoot,
      factory: defaultMCPClientFactory,
      connectTimeoutMs: env.CLARVIS_MCP_CONNECT_TIMEOUT_MS,
      callTimeoutMs: env.CLARVIS_MCP_TOOL_CALL_TIMEOUT_MS,
    }),
    traceStore: createMemoryTraceStore(),
    workspaceRoot,
    capabilities: [createAgentToolsCapability(), createAskUserCapability()],
  };
}

describe("kernel over loop, driven by settings (the closed loop)", () => {
  it("runs to completion from settings + agent: streams RunEvents, returns a result", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-kernel-"));
    const kernel = createInProcessKernel({
      deps: buildDeps(ws),
      workspaceRoot: ws,
      ...kernelIdentity(ws),
      configStore: seededConfig(),
    });

    expect((await kernel.listAgents()).map((a) => a.name)).toContain("solo");

    const params: StartRunParams = {
      messages: [{ role: "user", content: "Do it" }],
      agent: "solo",
    };
    const handle = await kernel.runs.start(params);

    const events: RunEvent[] = [];
    for await (const ev of handle.events) events.push(ev);
    const result = await handle.done;

    expect(result.status).toBe("completed");
    expect(result.execution_id).toBe(handle.execution_id);
    expect(result.usage?.iterations).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === "run_started")).toBe(true);
    expect(events.some((e) => e.type === "run_ended")).toBe(true);
    expect(events.every((e) => typeof e.at === "number")).toBe(true);

    await kernel.close();
  });

  it("streams live tool output while bash runs, but stores none of it (rehydration reads only the trace)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-kernel-"));
    const kernel = createInProcessKernel({
      deps: buildDeps(ws, [
        {
          toolCalls: [
            {
              name: "shell",
              arguments: { command: "printf 'one\\n'; sleep 0.5; printf 'two\\n'" },
            },
          ],
        },
        { text: "Done." },
      ]),
      workspaceRoot: ws,
      ...kernelIdentity(ws),
      configStore: seededConfig(),
    });

    const handle = await kernel.runs.start({
      messages: [{ role: "user", content: "run it" }],
      agent: "sysop",
    });
    const events: RunEvent[] = [];
    for await (const ev of handle.events) events.push(ev);
    const result = await handle.done;
    expect(result.status).toBe("completed");

    const deltas = events.filter((e) => e.type === "tool_output_delta");
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(deltas[0]!.chunk).toContain("one");
    const started = events.find((e) => e.type === "tool_call_started");
    expect(started?.type === "tool_call_started" && deltas[0]!.call_id === started.call_id).toBe(
      true,
    );

    const detail = await kernel.runs.get(result.execution_id);
    expect(detail.events.some((e) => e.type === "tool_output_delta")).toBe(false);
    expect(detail.events.some((e) => e.type === "tool_call")).toBe(true);

    await kernel.close();
  });

  it("get / list / delete round-trip against the trace store", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-kernel-"));
    const kernel = createInProcessKernel({
      deps: buildDeps(ws),
      workspaceRoot: ws,
      ...kernelIdentity(ws),
      configStore: seededConfig(),
    });

    const handle = await kernel.runs.start({
      messages: [{ role: "user", content: "hi" }],
      agent: "solo",
    });
    for await (const _ of handle.events) void _;
    const result = await handle.done;

    const detail = await kernel.runs.get(result.execution_id);
    expect(detail.execution_id).toBe(result.execution_id);
    expect(detail.status).toBe("completed");
    expect(detail.messages.length).toBeGreaterThanOrEqual(1);

    const page = await kernel.runs.list();
    expect(page.total).toBeGreaterThanOrEqual(1);
    expect(page.items.some((r) => r.execution_id === result.execution_id)).toBe(true);
    await expect(kernel.runs.list({ limit: MAX_TRACE_LIST_LIMIT + 1 })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(kernel.runs.list({ offset: MAX_TRACE_LIST_OFFSET + 1 })).rejects.toMatchObject({
      code: "invalid_request",
    });

    await kernel.runs.delete(result.execution_id);
    await expect(kernel.runs.get(result.execution_id)).rejects.toMatchObject({ code: "not_found" });

    await kernel.close();
  });

  it("rejects a duplicate owner-scoped execution id before launching a second run", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-kernel-"));
    let releasedLeases = 0;
    const kernel = createInProcessKernel({
      deps: buildDeps(ws, [
        { toolCalls: [{ name: "shell", arguments: { command: "sleep 2" } }] },
        { text: "Done." },
      ]),
      workspaceRoot: ws,
      ...kernelIdentity(ws),
      configStore: seededConfig(),
      acquireRunLease: () => () => {
        releasedLeases += 1;
      },
    });
    const params: StartRunParams = {
      execution_id: "one-owner-one-run",
      messages: [{ role: "user", content: "run it" }],
      agent: "sysop",
    };

    const first = await kernel.runs.start(params);
    await expect(kernel.runs.start(params)).rejects.toMatchObject({ code: "conflict" });
    expect(releasedLeases).toBe(1);

    await first.cancel();
    await first.done;
    await first.closed;
    expect(releasedLeases).toBe(2);
    await kernel.close();
  });

  it("fails as a terminal result when the requested agent is not defined", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-kernel-"));
    const kernel = createInProcessKernel({
      deps: buildDeps(ws),
      workspaceRoot: ws,
      ...kernelIdentity(ws),
      configStore: createMemoryConfigStore({
        settings: { workspace: { providers: PROVIDERS, default_model: "anthropic/x" } },
      }),
    });

    const handle = await kernel.runs.start({
      messages: [{ role: "user", content: "x" }],
      agent: "ghost",
    });
    for await (const _ of handle.events) void _;
    const result = await handle.done;

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("not_found");

    await kernel.close();
  });

  it("kernel close cancels active runs, is idempotent, and rejects later starts through done", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-kernel-"));
    const kernel = createInProcessKernel({
      deps: buildDeps(ws, [
        { toolCalls: [{ name: "shell", arguments: { command: "sleep 2" } }] },
        { text: "Done." },
      ]),
      workspaceRoot: ws,
      ...kernelIdentity(ws),
      configStore: seededConfig(),
    });
    const active = await kernel.runs.start({
      messages: [{ role: "user", content: "run it" }],
      agent: "sysop",
    });
    for await (const event of active.events) {
      if (event.type === "tool_call_started") {
        await kernel.close();
      }
    }
    expect((await active.done).status).not.toBe("running");
    await expect(kernel.close()).resolves.toBeUndefined();

    const rejected = await kernel.runs.start({
      messages: [{ role: "user", content: "too late" }],
      agent: "solo",
    });
    for await (const _event of rejected.events) void _event;
    await expect(rejected.done).resolves.toMatchObject({
      status: "failed",
      error: { code: "unavailable" },
    });
  });
});
