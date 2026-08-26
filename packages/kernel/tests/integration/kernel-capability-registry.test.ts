import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "bun:test";
import {
  createCapabilityRegistry,
  loadEnv,
  type CapabilitySettingsSpec,
} from "@clarvis/capability";
import { createConnectionManager, defaultMCPClientFactory } from "@clarvis/mcp-client";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import { MockLLM } from "@clarvis/loop/testing";
import { createAgentToolsCapability } from "@clarvis/loop/capabilities/tools";
import { createAskUserCapability, type ExecuteRunDeps } from "@clarvis/loop";
import { z } from "zod";
import type { RunEvent, StartRunParams } from "@clarvis/protocol";
import { createInProcessKernel } from "../../src/index.ts";
import { createMemoryConfigStore } from "../../src/config.ts";
import { kernelIdentity } from "../helpers/kernel-identity.ts";

const PROVIDERS = [{ name: "anthropic", kind: "anthropic" }];

function config(over: Record<string, unknown> = {}) {
  return createMemoryConfigStore({
    settings: {
      workspace: { providers: PROVIDERS, default_model: "anthropic/x", ...over },
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

function deps(workspaceRoot: string, over: Partial<ExecuteRunDeps> = {}): ExecuteRunDeps {
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
    ...over,
  };
}

const params: StartRunParams = { messages: [{ role: "user", content: "Do it" }], agent: "solo" };

/**
 * Every per-run param a registered capability declares has to be in the request
 * schema, or `strict()` rejects the whole body. This kernel emits two of them
 * itself — `plans` from a workspace's settings block, and `plans: "off"` forced
 * onto every workflow leader — so its own registry cannot be optional.
 *
 * It used to be a fallback (`deps.capabilityRegistry ?? kernelCapabilityRegistry`),
 * which covers only a host that passed no registry at all. `buildExecuteRunDeps`
 * always passes one, and with planning off it passes an *empty* one — defined,
 * so the fallback never fires, and every run then dies on an unrecognized
 * `plans` key. Merging is what makes the kernel's own blocks unconditional.
 */
describe("createInProcessKernel — capability settings registry", () => {
  it("accepts its own capabilities' params when the host supplied an empty registry", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-reg-"));
    const kernel = createInProcessKernel({
      deps: deps(ws, { capabilityRegistry: createCapabilityRegistry() }),
      workspaceRoot: ws,
      ...kernelIdentity(ws),
      configStore: config({ plans: { mode: "off" } }),
    });

    const handle = await kernel.runs.start(params);
    const events: RunEvent[] = [];
    for await (const ev of handle.events) events.push(ev);
    expect((await handle.done).status).toBe("completed");
    await kernel.close();
  });

  it("carries a host's own registered param alongside, rather than replacing it", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-reg-"));
    const hostRegistry = createCapabilityRegistry();
    const spec: CapabilitySettingsSpec = {
      key: "widgets",
      schema: z.object({ enabled: z.boolean() }).strict(),
      merge: "lastWins",
      pluginContributable: false,
      requestParams: { widgets: z.boolean().optional() },
    };
    hostRegistry.register(spec);

    const kernel = createInProcessKernel({
      deps: deps(ws, { capabilityRegistry: hostRegistry }),
      workspaceRoot: ws,
      ...kernelIdentity(ws),
      configStore: config(),
      assembleRunRequest: (p) => ({
        messages: p.messages,
        servers: [],
        profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 5 }],
        entry: "solo",
        providers: PROVIDERS,
        budget: { on_exceed: "stop", total_token_limit: 1000 },
        // Both must survive validation: the kernel's own and the host's.
        plans: "off",
        widgets: true,
      }),
    });

    const handle = await kernel.runs.start(params);
    const events: RunEvent[] = [];
    for await (const ev of handle.events) events.push(ev);
    expect((await handle.done).status).toBe("completed");
    await kernel.close();
  });

  it("preserves host grant declarations while merging the kernel registry", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-reg-"));
    const hostRegistry = createCapabilityRegistry();
    hostRegistry.registerGrant({ name: "host_audit" });

    const kernel = createInProcessKernel({
      deps: deps(ws, { capabilityRegistry: hostRegistry }),
      workspaceRoot: ws,
      ...kernelIdentity(ws),
      configStore: config(),
      assembleRunRequest: (p) => ({
        messages: p.messages,
        servers: [],
        profiles: [
          {
            name: "solo",
            model: "anthropic/x",
            tools: [],
            iteration_limit: 5,
            grants: ["host_audit"],
          },
        ],
        entry: "solo",
        providers: PROVIDERS,
        budget: { on_exceed: "stop", total_token_limit: 1000 },
      }),
    });

    const handle = await kernel.runs.start(params);
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);
    expect((await handle.done).status).toBe("completed");
    await kernel.close();
  });
});
