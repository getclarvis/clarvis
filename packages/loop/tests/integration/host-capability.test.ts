import { describe, it, expect } from "../bun-test.ts";
import { MockLLM, mockConnections, mockMCPFactory } from "./_fixtures.ts";
import { createExtensionAdmissionController, loadEnv } from "@clarvis/capability";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import { executeRun, type ExecuteRunDeps } from "../../src/runtime/execute-run.ts";
import type { Capability, CapabilityEvent } from "@clarvis/capability";
import type { LiveMessage } from "@clarvis/capability";

const SEED_TAG = "<host-context>";
const SEED_BLOCK = `${SEED_TAG}\nThe host pinned this block.\n</host-context>`;

const HOST_TOOL = {
  fullName: "host_ping",
  wireName: "host_ping",
  mcpName: "",
  toolName: "host_ping",
  description: "Ping the host capability.",
  inputSchema: { type: "object" as const, properties: {} },
};

function hostCapability(log: {
  toolsSeen: string[];
  gateAttempts: string[];
  runEndStatus: string[];
}): Capability {
  return {
    name: "host-test",
    seedMarker: SEED_TAG,
    forRun(ctx) {
      return {
        name: "host-test",
        seedBlock: () => SEED_BLOCK,
        lifecycle: [
          {
            beforeToolUse: async (c) => {
              log.toolsSeen.push(c.tool);
              return { kind: "pass" };
            },
          },
        ],
        forAgent() {
          return {
            attach() {
              let nudged = false;
              return {
                tools: [HOST_TOOL],
                handlers: [
                  {
                    matches: (call) => call.name === "host_ping",
                    handle: async () => ({
                      kind: "result" as const,
                      text: "Tool 'host_ping' result: pong",
                      progress: true,
                    }),
                  },
                ],
                gates: [
                  {
                    check: async (attempt) => {
                      log.gateAttempts.push(attempt.mode);
                      if (nudged) return { kind: "pass" as const };
                      nudged = true;
                      return {
                        kind: "nudge" as const,
                        note: "[host gate: confirm the final answer once more]",
                      };
                    },
                  },
                ],
                advertised: true,
              };
            },
          };
        },
        onRunEnd(record) {
          log.runEndStatus.push(record.status);
          ctx.emit({ capability: "host-test", kind: "run-finished" });
        },
      };
    },
  };
}

function makeDeps(llm: MockLLM): ExecuteRunDeps {
  const env = loadEnv({ CLARVIS_MCP_CONNECT_TIMEOUT_MS: "2000", CLARVIS_LOG_LEVEL: "silent" });
  return {
    env,
    llm,
    connections: mockConnections(mockMCPFactory({}), env),
    traceStore: createMemoryTraceStore(),
    workspaceRoot: process.cwd(),
  };
}

function userTexts(messages: LiveMessage[]): string[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : ""));
}

describe("a host extends the loop by registering a capability", () => {
  it("seed block, tool, gate, lifecycle hook and event all flow from one registration", async () => {
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "host_ping", arguments: {} }] },
        { text: "final answer" },
        { text: "final answer" },
      ],
    });
    const log = {
      toolsSeen: [] as string[],
      gateAttempts: [] as string[],
      runEndStatus: [] as string[],
    };
    const events: CapabilityEvent[] = [];

    const { response } = await executeRun({
      rawBody: {
        messages: [{ role: "user", content: "go" }],
        servers: [],
        providers: [{ name: "anthropic", kind: "anthropic" }],
        profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 5 }],
        entry: "solo",
        budget: { on_exceed: "stop", total_token_limit: 100_000 },
      },
      owner: "host",
      deps: makeDeps(llm),
      capabilities: [hostCapability(log)],
      onCapabilityEvent: (e) => events.push(e),
    });

    expect(response.status).toBe("completed");
    expect((response as { result: unknown }).result).toBe("final answer");

    expect(userTexts(llm.calls[0]!.messages)).toContain(SEED_BLOCK);
    expect(llm.calls[0]!.tools.some((t) => t.wireName === "host_ping")).toBe(true);
    expect(JSON.stringify(llm.calls[1]!.messages)).toContain("pong");
    expect(log.toolsSeen).toEqual(["host_ping"]);
    expect(log.gateAttempts).toEqual(["text", "text"]);
    expect(JSON.stringify(llm.calls[2]!.messages)).toContain("confirm the final answer");
    expect(log.runEndStatus).toEqual(["completed"]);
    expect(events).toEqual([{ capability: "host-test", kind: "run-finished" }]);
  });
});

/**
 * The engine's own `onRunEnd` fold, exercised without any particular feature.
 *
 * @remarks These paths were once covered only incidentally, by a feature's own
 * suite that happened to drive them. The behaviour is the loop's, so it is
 * asserted directly: run-end work is collected, a rejection and a synchronous
 * throw are both logged without touching the run, and the whole set is awaited
 * under a bounded budget so a slow capability cannot hold the response open.
 */
describe("executeRun — capability run-end", () => {
  function runEndCapability(
    name: string,
    onRunEnd: (record: { id: string }) => void | Promise<void>,
  ): Capability {
    return {
      name,
      forRun() {
        return { name, forAgent: () => null, onRunEnd };
      },
    };
  }

  async function runWith(capabilities: Capability[], env?: Record<string, string>) {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    const base = makeDeps(llm);
    const warnings: unknown[][] = [];
    return executeRun({
      rawBody: {
        messages: [{ role: "user", content: "go" }],
        servers: [],
        providers: [{ name: "anthropic", kind: "anthropic" }],
        profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
        entry: "solo",
        budget: { on_exceed: "stop", total_token_limit: 100_000 },
      },
      owner: "host",
      deps: {
        ...base,
        ...(env === undefined ? {} : { env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", ...env }) }),
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: (...args: unknown[]) => warnings.push(args),
          error: () => undefined,
        } as unknown as NonNullable<ExecuteRunDeps["logger"]>,
      },
      capabilities,
    }).then((outcome) => ({ outcome, warnings }));
  }

  it("awaits every capability's durable run-end work before resolving", async () => {
    const order: string[] = [];
    const { outcome } = await runWith([
      runEndCapability("a", async () => {
        await Bun.sleep(5);
        order.push("a");
      }),
      runEndCapability("b", () => {
        order.push("b");
      }),
    ]);

    expect(outcome.response.status).toBe("completed");
    expect(order).toContain("a");
    expect(order).toContain("b");
  });

  it("logs a rejected or throwing onRunEnd and leaves the run untouched", async () => {
    const { outcome, warnings } = await runWith([
      runEndCapability("rejects", () => Promise.reject(new Error("async boom"))),
      runEndCapability("throws", () => {
        throw new Error("sync boom");
      }),
    ]);

    expect(outcome.response.status).toBe("completed");
    const text = JSON.stringify(warnings);
    expect(text).toContain("capability_run_end_failed");
    expect(text).toContain("async boom");
    expect(text).toContain("sync boom");
  });

  it("stops waiting once the run-end budget elapses, and says so", async () => {
    // The work is not cancelled — it simply stops being waited on, which is what
    // keeps one slow capability from holding a user's response open.
    const { outcome, warnings } = await runWith([runEndCapability("slow", () => Bun.sleep(400))], {
      CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS: "20",
    });

    expect(outcome.response.status).toBe("completed");
    expect(JSON.stringify(warnings)).toContain("capability_run_end_timeout");
  });
});

describe("executeRun — capability setup", () => {
  async function runWith(
    capabilities: Capability[],
    externalSignal?: AbortSignal,
    llm = new MockLLM({ script: [{ text: "done" }] }),
    extensionAdmission?: ExecuteRunDeps["extensionAdmission"],
  ) {
    const base = makeDeps(llm);
    const warnings: unknown[][] = [];
    const outcome = await executeRun({
      rawBody: {
        messages: [{ role: "user", content: "go" }],
        servers: [],
        providers: [{ name: "anthropic", kind: "anthropic" }],
        profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
        entry: "solo",
        budget: { on_exceed: "stop", total_token_limit: 100_000 },
      },
      owner: "host",
      deps: {
        ...base,
        ...(extensionAdmission === undefined ? {} : { extensionAdmission }),
        env: loadEnv({
          CLARVIS_LOG_LEVEL: "silent",
          CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS: "5",
        }),
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: (...args: unknown[]) => warnings.push(args),
          error: () => undefined,
        } as unknown as NonNullable<ExecuteRunDeps["logger"]>,
      },
      capabilities,
      ...(externalSignal !== undefined ? { externalSignal } : {}),
    });
    return { outcome, warnings };
  }

  it("skips an activation that never settles without delaying sibling capabilities", async () => {
    let siblingActivated = false;
    const { outcome, warnings } = await runWith([
      {
        name: "stuck-activation",
        forRun: () => new Promise<never>(() => undefined),
      },
      {
        name: "sibling",
        forRun: () => {
          siblingActivated = true;
          return { name: "sibling", forAgent: () => null };
        },
      },
    ]);

    expect(outcome.response.status).toBe("completed");
    expect(siblingActivated).toBe(true);
    expect(JSON.stringify(warnings)).toContain("capability.setup_timeout");
  });

  it.each(["declined", "timeout", "missing-seed", "empty-seed", "seed-timeout", "missing-entry"])(
    "refuses mandatory capability %s before any inference",
    async (mode) => {
      const llm = new MockLLM({ script: [{ text: "must not infer" }] });
      const capability: Capability = {
        name: "mandatory",
        required: true,
        forRun: () => {
          if (mode === "declined") return null;
          if (mode === "timeout") return new Promise<never>(() => undefined);
          return {
            name: "mandatory",
            seedBlock: () =>
              mode === "missing-seed"
                ? undefined
                : mode === "empty-seed"
                  ? "  "
                  : mode === "seed-timeout"
                    ? new Promise<never>(() => undefined)
                    : "required context",
            forAgent: () => (mode === "missing-entry" ? null : { attach: () => ({}) }),
          };
        },
      };
      if (mode === "missing-entry") {
        const { outcome } = await runWith([capability], undefined, llm);
        expect(outcome.response).toMatchObject({
          status: "error",
          error: { code: "required_capability_unavailable" },
        });
      } else
        await expect(runWith([capability], undefined, llm)).rejects.toMatchObject({
          code: "required_capability_unavailable",
        });
      expect(llm.calls).toEqual([]);
    },
  );

  it("activates mandatory controls and keeps pre-start cancellation distinct from missing controls", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    const { outcome } = await runWith(
      [
        {
          name: "ready",
          required: true,
          forRun: () => ({ name: "ready", forAgent: () => ({ attach: () => ({}) }) }),
        },
      ],
      undefined,
      llm,
    );
    expect(outcome.response.status).toBe("completed");
    expect(llm.calls).toHaveLength(1);
    const cancelled = new MockLLM({ script: [] });
    const result = await runWith(
      [{ name: "cancelled", required: true, forRun: () => null }],
      AbortSignal.abort(),
      cancelled,
    );
    expect(result.outcome.response.status).toBe("cancelled");
    expect(cancelled.calls).toEqual([]);
  });

  it("omits a seed contribution that never settles and completes the run", async () => {
    const { outcome, warnings } = await runWith([
      {
        name: "stuck-seed",
        forRun: () => ({
          name: "stuck-seed",
          seedBlock: () => new Promise<never>(() => undefined),
          forAgent: () => null,
        }),
      },
    ]);

    expect(outcome.response.status).toBe("completed");
    expect(JSON.stringify(warnings)).toContain("capability.setup_timeout");
  });

  it("refuses mandatory activation when physical extension capacity is unavailable", async () => {
    const admission = createExtensionAdmissionController({
      maxActiveNormal: 1,
      maxActiveRunEnd: 1,
      maxActivePerOperation: 1,
    });
    const release = Promise.withResolvers<void>();
    const held = admission.call("held", "normal", () => release.promise);
    const llm = new MockLLM({ script: [] });
    let invoked = false;
    try {
      await expect(
        runWith(
          [
            {
              name: "mandatory",
              required: true,
              forRun: () => {
                invoked = true;
                return null;
              },
            },
          ],
          undefined,
          llm,
          admission,
        ),
      ).rejects.toMatchObject({ code: "required_capability_unavailable" });
      expect(invoked).toBe(false);
      expect(llm.calls).toEqual([]);
    } finally {
      release.resolve();
      await held;
    }
  });

  it.each(["scope", "attach"] as const)(
    "validates required entry %s before auxiliary vision inference",
    async (phase) => {
      const llm = new MockLLM({ script: [{ text: "must not read the image" }] });
      const outcome = await executeRun({
        owner: "host",
        deps: makeDeps(llm),
        rawBody: {
          messages: [
            { role: "user", content: [{ type: "image", image: "data:image/png;base64,YQ==" }] },
          ],
          servers: [],
          providers: [
            {
              name: "anthropic",
              kind: "anthropic",
              models: {
                text: { context_window_tokens: 10000, capabilities: [] },
                vision: { context_window_tokens: 10000, capabilities: ["vision"] },
              },
            },
          ],
          profiles: [{ name: "solo", model: "anthropic/text", tools: [], iteration_limit: 2 }],
          entry: "solo",
          vision_model: "anthropic/vision",
          budget: { on_exceed: "stop", total_token_limit: 10000 },
        },
        capabilities: [
          {
            name: "required",
            required: true,
            forRun: () => ({
              name: "required",
              forAgent: () =>
                phase === "scope"
                  ? null
                  : {
                      attach: () => {
                        throw new Error("private attachment failure");
                      },
                    },
            }),
          },
        ],
      });
      expect(llm.calls).toEqual([]);
      expect(outcome.response).toMatchObject({
        status: "error",
        error: { code: "required_capability_unavailable" },
      });
      expect(JSON.stringify(outcome.response)).not.toContain("private attachment failure");
    },
  );

  it("still activates and finalizes capabilities when the run is already cancelled", async () => {
    const ended: string[] = [];
    const { outcome } = await runWith(
      [
        {
          name: "cancelled-run-observer",
          forRun: () => ({
            name: "cancelled-run-observer",
            forAgent: () => null,
            onRunEnd: (record) => {
              ended.push(record.status);
            },
          }),
        },
      ],
      AbortSignal.abort({ source: "test" }),
    );

    expect(outcome.response.status).toBe("cancelled");
    expect(ended).toEqual(["cancelled"]);
  });
});

describe("executeRun — physical extension admission", () => {
  const rawBody = {
    messages: [{ role: "user" as const, content: "go" }],
    servers: [],
    providers: [{ name: "anthropic", kind: "anthropic" as const }],
    profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
    entry: "solo",
    budget: { on_exceed: "stop" as const, total_token_limit: 100_000 },
  };

  function iterativeDeps(
    runs: number,
    env: ExecuteRunDeps["env"],
    extensionAdmission: NonNullable<ExecuteRunDeps["extensionAdmission"]>,
  ): ExecuteRunDeps {
    const base = makeDeps(
      new MockLLM({ script: Array.from({ length: runs }, () => ({ text: "done" })) }),
    );
    return {
      ...base,
      env,
      extensionAdmission,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      } as unknown as NonNullable<ExecuteRunDeps["logger"]>,
    };
  }

  it("bounds iterative forRun, seedBlock and lifecycle zombies while healthy siblings run", async () => {
    const runs = 6;
    const admission = createExtensionAdmissionController({
      maxActiveNormal: 16,
      maxActiveRunEnd: 8,
      maxActivePerOperation: 2,
    });
    const env = loadEnv({
      CLARVIS_LOG_LEVEL: "silent",
      CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS: "1",
      CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS: "16",
      CLARVIS_MAX_CONCURRENT_EXTENSION_RUN_END_CALLS: "8",
      CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS_PER_OPERATION: "2",
    });
    const deps = iterativeDeps(runs, env, admission);
    let activationStarts = 0;
    let seedStarts = 0;
    let hookStarts = 0;
    let healthyStarts = 0;
    const capabilities: Capability[] = [
      {
        name: "stuck-activation",
        forRun: () => {
          activationStarts += 1;
          return new Promise<never>(() => undefined);
        },
      },
      {
        name: "stuck-seed",
        forRun: () => ({
          name: "stuck-seed",
          seedBlock: () => {
            seedStarts += 1;
            return new Promise<never>(() => undefined);
          },
          forAgent: () => null,
        }),
      },
      {
        name: "stuck-lifecycle",
        forRun: () => ({
          name: "stuck-lifecycle",
          lifecycle: [
            {
              onRunStart: () => {
                hookStarts += 1;
                return new Promise<never>(() => undefined);
              },
            },
          ],
          forAgent: () => null,
        }),
      },
      {
        name: "healthy-lifecycle",
        forRun: () => ({
          name: "healthy-lifecycle",
          lifecycle: [
            {
              onRunStart: async () => {
                healthyStarts += 1;
              },
            },
          ],
          forAgent: () => null,
        }),
      },
    ];

    for (let index = 0; index < runs; index += 1) {
      const outcome = await executeRun({ rawBody, owner: "host", deps, capabilities });
      expect(outcome.response.status).toBe("completed");
    }

    expect({ activationStarts, seedStarts, hookStarts, healthyStarts }).toEqual({
      activationStarts: 2,
      seedStarts: 2,
      hookStarts: 2,
      healthyStarts: runs,
    });
    expect(admission.snapshot()).toMatchObject({ activeNormal: 6, activeRunEnd: 0 });
  });

  it("bounds finalizer and both run-end observer surfaces without starving siblings", async () => {
    const runs = 5;
    const admission = createExtensionAdmissionController({
      maxActiveNormal: 8,
      maxActiveRunEnd: 8,
      maxActivePerOperation: 2,
    });
    const env = loadEnv({
      CLARVIS_LOG_LEVEL: "silent",
      CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS: "1",
    });
    const deps = iterativeDeps(runs, env, admission);
    let stuckFinalize = 0;
    let stuckCapabilityEnd = 0;
    let stuckLifecycleEnd = 0;
    let healthyFinalize = 0;
    let healthyCapabilityEnd = 0;
    let healthyLifecycleEnd = 0;
    const capabilities: Capability[] = [
      {
        name: "stuck-run-end",
        forRun: () => ({
          name: "stuck-run-end",
          lifecycle: [
            {
              onRunEnd: () => {
                stuckLifecycleEnd += 1;
                return new Promise<never>(() => undefined);
              },
            },
          ],
          forAgent: () => null,
          finalizeRun: () => {
            stuckFinalize += 1;
            return new Promise<never>(() => undefined);
          },
          onRunEnd: () => {
            stuckCapabilityEnd += 1;
            return new Promise<never>(() => undefined);
          },
        }),
      },
      {
        name: "healthy-run-end",
        forRun: () => ({
          name: "healthy-run-end",
          lifecycle: [
            {
              onRunEnd: async () => {
                healthyLifecycleEnd += 1;
              },
            },
          ],
          forAgent: () => null,
          finalizeRun: () => {
            healthyFinalize += 1;
            return { ok: true };
          },
          onRunEnd: async () => {
            healthyCapabilityEnd += 1;
          },
        }),
      },
    ];

    for (let index = 0; index < runs; index += 1) {
      const outcome = await executeRun({ rawBody, owner: "host", deps, capabilities });
      expect(outcome.response.status).toBe("completed");
    }

    expect({ stuckFinalize, stuckCapabilityEnd, stuckLifecycleEnd }).toEqual({
      stuckFinalize: 2,
      stuckCapabilityEnd: 2,
      stuckLifecycleEnd: 2,
    });
    expect({ healthyFinalize, healthyCapabilityEnd, healthyLifecycleEnd }).toEqual({
      healthyFinalize: runs,
      healthyCapabilityEnd: runs,
      healthyLifecycleEnd: runs,
    });
    expect(admission.snapshot()).toMatchObject({ activeNormal: 0, activeRunEnd: 6 });
  });

  it("uses the run-end reserve to activate and finalize an already-cancelled run", async () => {
    const admission = createExtensionAdmissionController({
      maxActiveNormal: 1,
      maxActiveRunEnd: 4,
      maxActivePerOperation: 2,
    });
    void admission.call("stuck:ordinary", "normal", () => new Promise<never>(() => undefined));
    const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
    const deps = iterativeDeps(1, env, admission);
    const seen: string[] = [];
    const capability: Capability = {
      name: "cancelled-observer",
      forRun: () => {
        seen.push("activate");
        return {
          name: "cancelled-observer",
          lifecycle: [
            {
              onRunEnd: async () => {
                seen.push("lifecycle-end");
              },
            },
          ],
          forAgent: () => null,
          finalizeRun: () => {
            seen.push("finalize");
          },
          onRunEnd: async () => {
            seen.push("capability-end");
          },
        };
      },
    };

    const outcome = await executeRun({
      rawBody,
      owner: "host",
      deps,
      capabilities: [capability],
      externalSignal: AbortSignal.abort({ source: "test" }),
    });

    expect(outcome.response.status).toBe("cancelled");
    expect(seen).toEqual(["activate", "lifecycle-end", "finalize", "capability-end"]);
    expect(admission.snapshot()).toMatchObject({ activeNormal: 1, activeRunEnd: 0 });
  });
});
