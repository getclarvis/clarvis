import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "bun:test";
import { loadEnv } from "@clarvis/capability";
import { createConnectionManager, defaultMCPClientFactory } from "@clarvis/mcp-client";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import { MockLLM } from "@clarvis/loop/testing";
import { createAgentToolsCapability } from "@clarvis/loop/capabilities/tools";
import { createAskUserCapability, type ExecuteRunDeps } from "@clarvis/loop";
import type { RunEvent } from "@clarvis/protocol";
import { createInProcessKernel } from "../../src/index.ts";
import { createMemoryConfigStore } from "../../src/config.ts";
import { kernelIdentity } from "../helpers/kernel-identity.ts";

function seededConfig() {
  return createMemoryConfigStore({
    settings: {
      workspace: {
        providers: [{ name: "anthropic", kind: "anthropic" }],
        default_model: "anthropic/x",
      },
    },
    agents: [
      {
        name: "solo",
        scope: "workspace",
        frontmatter: { model: "anthropic/x", tools: [] },
        body: "You are solo.",
        model: "anthropic/x",
      },
    ],
  });
}

function buildDeps(workspaceRoot: string): ExecuteRunDeps {
  const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_MCP_CONNECT_TIMEOUT_MS: "2000" });
  return {
    env,
    llm: new MockLLM({ script: [{ text: "Done." }] }),
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

describe("createInProcessKernel — event-stream default", () => {
  it("uses the shared bounded default without dropping a normally drained run", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-kernel-evb-"));
    const kernel = createInProcessKernel({
      deps: buildDeps(ws),
      workspaceRoot: ws,
      ...kernelIdentity(ws),
      configStore: seededConfig(),
    });

    const handle = await kernel.runs.start({
      messages: [{ role: "user", content: "Do it" }],
      agent: "solo",
    });
    await handle.done;
    const events: RunEvent[] = [];
    for await (const ev of handle.events) events.push(ev);

    expect(events.some((e) => e.type === "events_dropped")).toBe(false);
    await kernel.close();
  });

  it("a host can opt into capping via CreateKernelOptions.eventBuffer", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-kernel-evb-"));
    const kernel = createInProcessKernel({
      deps: buildDeps(ws),
      workspaceRoot: ws,
      ...kernelIdentity(ws),
      configStore: seededConfig(),
      eventBuffer: { maxBuffered: 2, droppable: (e) => e.type !== "run_ended" },
    });

    const handle = await kernel.runs.start({
      messages: [{ role: "user", content: "Do it" }],
      agent: "solo",
    });
    await handle.done;
    const events: RunEvent[] = [];
    for await (const ev of handle.events) events.push(ev);

    expect(events.some((e) => e.type === "events_dropped")).toBe(true);
    await kernel.close();
  });
});
