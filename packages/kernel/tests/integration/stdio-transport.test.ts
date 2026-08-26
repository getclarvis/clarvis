import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "bun:test";
import { loadEnv } from "@clarvis/capability";
import { createConnectionManager, defaultMCPClientFactory } from "@clarvis/mcp-client";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import { MockLLM } from "@clarvis/loop/testing";
import { createAgentToolsCapability } from "@clarvis/loop/capabilities/tools";
import { createAskUserCapability, type ExecuteRunDeps } from "@clarvis/loop";
import type { RunEvent } from "@clarvis/protocol";
import {
  createInProcessKernel,
  createKernelServer,
  createStdioTransport,
  serveKernelOverStdio,
  connectKernelClient,
} from "../../src/index.ts";
import { createMemoryConfigStore } from "../../src/config.ts";
import { kernelIdentity } from "../helpers/kernel-identity.ts";

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

it("streams one real kernel run over the stdio NDJSON byte boundary", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "clarvis-kernel-stdio-"));
  const kernel = createInProcessKernel({
    deps: buildDeps(workspaceRoot),
    workspaceRoot,
    ...kernelIdentity(workspaceRoot),
    configStore: createMemoryConfigStore({
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
    }),
  });
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  serveKernelOverStdio(createKernelServer(kernel), { input: toServer, output: toClient });
  const client = await connectKernelClient(
    createStdioTransport({ input: toClient, output: toServer }),
  );

  expect((await client.config.listAgents()).map((agent) => agent.name)).toContain("solo");
  const handle = await client.runs.start({
    messages: [{ role: "user", content: "Do it" }],
    agent: "solo",
  });
  const events: RunEvent[] = [];
  for await (const event of handle.events) events.push(event);

  expect((await handle.done).status).toBe("completed");
  expect(events.some((event) => event.type === "run_started")).toBe(true);
  expect(events.some((event) => event.type === "run_ended")).toBe(true);

  await client.close();
  await kernel.close();
});
