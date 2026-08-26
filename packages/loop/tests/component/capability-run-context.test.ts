import { describe, expect, it } from "../bun-test.ts";

import { loadEnv, ValidationError } from "@clarvis/capability";
import type {
  Capability,
  LLMCallParams,
  LLMCallResult,
  LLMProvider,
  RunCapabilityContext,
} from "@clarvis/capability";
import { executeRun, type ExecuteRunDeps } from "../../src/runtime/execute-run.ts";
import { MockLLM, mockConnections, mockMCPFactory } from "../helpers/fixtures.ts";
import { makeTestTraceStore } from "../contract/_helpers.ts";
import { AGENT_REGISTRY_PORT } from "@clarvis/supervision";

const BODY = {
  messages: [{ role: "user", content: "go" }],
  servers: [],
  profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 2 }],
  entry: "solo",
  providers: [{ name: "anthropic", kind: "anthropic" }],
  budget: { on_exceed: "stop", total_token_limit: 1000 },
};

/** Records the prompt-cache options each call was made with. */
function spyLLM(): { llm: LLMProvider; ttls: (string | undefined)[] } {
  const inner = new MockLLM({ script: [{ text: "done" }] });
  const ttls: (string | undefined)[] = [];
  return {
    ttls,
    llm: {
      call(params: LLMCallParams): Promise<LLMCallResult> {
        ttls.push(params.promptCacheTtl);
        return inner.call(params);
      },
    },
  };
}

function makeDeps(capabilities: Capability[], llm?: LLMProvider): ExecuteRunDeps {
  return {
    env: loadEnv({}),
    llm: llm ?? new MockLLM({ script: [{ text: "done" }] }),
    connections: mockConnections(mockMCPFactory({})),
    traceStore: makeTestTraceStore(),
    workspaceRoot: process.cwd(),
    capabilities,
  };
}

/** A capability that files `state` at the end of a run and records the
 * `priorState` it was handed at the start of one. */
function stateful(name: string, state: unknown): { cap: Capability; seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    seen,
    cap: {
      name,
      forRun(ctx: RunCapabilityContext) {
        seen.push(ctx.priorState);
        return { name, forAgent: () => null, finalizeRun: () => state };
      },
    },
  };
}

/**
 * `RunCapabilityContext` carries two things the engine cannot reconstruct for a
 * capability and cannot be told later: what the previous turn left behind, and
 * whether this run will have to reach a human. Both were declared on the
 * contract and read by a capability while nothing populated them — which is
 * invisible to a type-check, to a lint, and to every assertion about the
 * capability itself, because the capability is doing exactly what it was asked.
 */
describe("the run context a capability is built with", () => {
  it("hands a continued run the state the previous run filed", async () => {
    const first = stateful("plans", { id: "plan-1" });
    const deps = makeDeps([first.cap]);

    const one = await executeRun({ rawBody: BODY, owner: "test", deps });
    expect(one.response.status).toBe("completed");
    expect(first.seen).toEqual([undefined]);

    const stored = deps.traceStore.getById("test", one.executionId)!;
    expect(stored.capability_state).toEqual({ plans: { id: "plan-1" } });

    const second = stateful("plans", { id: "plan-1" });
    await executeRun({
      rawBody: { ...BODY, continue_from: one.executionId },
      owner: "test",
      deps: { ...deps, capabilities: [second.cap] },
    });
    // Without this the capability starts every continued turn blank: a plan
    // authored on turn 1 is invisible on turn 2, so the agent opens a second
    // one and files a ref for it over the first.
    expect(second.seen).toEqual([{ plans: { id: "plan-1" } }]);
  });

  it("leaves priorState absent when the previous run filed nothing", async () => {
    const nothing: Capability = {
      name: "quiet",
      forRun: () => ({ name: "quiet", forAgent: () => null }),
    };
    const deps = makeDeps([nothing]);
    const one = await executeRun({ rawBody: BODY, owner: "test", deps });

    const observer = stateful("quiet", undefined);
    await executeRun({
      rawBody: { ...BODY, continue_from: one.executionId },
      owner: "test",
      deps: { ...deps, capabilities: [observer.cap] },
    });
    expect(observer.seen).toEqual([undefined]);
  });

  it("publishes supervision before forRun regardless of capability order", async () => {
    const seen: boolean[] = [];
    const consumer: Capability = {
      name: "consumer",
      forRun(ctx) {
        seen.push(ctx.services.get(AGENT_REGISTRY_PORT) !== undefined);
        return null;
      },
    };
    const producerDeclaration: Capability = {
      name: "coordinator",
      grants: [{ name: "coordinate", entryCanSpawn: true }],
      forRun: () => null,
    };
    const managerBody = {
      ...BODY,
      profiles: [{ ...BODY.profiles[0], grants: ["coordinate"] }],
    };

    await executeRun({
      rawBody: managerBody,
      owner: "test",
      deps: makeDeps([consumer, producerDeclaration]),
    });
    await executeRun({
      rawBody: managerBody,
      owner: "test",
      deps: makeDeps([producerDeclaration, consumer]),
    });

    expect(seen).toEqual([true, true]);
  });

  it("does not publish supervision for a solo entry", async () => {
    let registryPresent = true;
    const observer: Capability = {
      name: "observer",
      forRun(ctx) {
        registryPresent = ctx.services.get(AGENT_REGISTRY_PORT) !== undefined;
        return null;
      },
    };
    await executeRun({ rawBody: BODY, owner: "test", deps: makeDeps([observer]) });
    expect(registryPresent).toBe(false);
  });
});

/** A capability that says this request will park on a human. */
const needsHuman: Capability = {
  name: "gate",
  requiresUserInput: () => true,
  forRun: () => ({ name: "gate", forAgent: () => null }),
};

describe("a capability that must reach the human", () => {
  it("buys the run the long prompt-cache TTL without an ask_user grant", async () => {
    const spy = spyLLM();
    await executeRun({
      rawBody: BODY,
      owner: "test",
      deps: makeDeps([needsHuman], spy.llm),
      elicit: () => Promise.resolve({ action: "decline" }),
    });
    // The run blocks on a person mid-flight. A 5m entry expires across an
    // approval and the next call re-charges the whole prefix as uncached input.
    expect(spy.ttls).toEqual(["1h"]);
  });

  it("still takes the short TTL when no capability needs a human", async () => {
    const spy = spyLLM();
    await executeRun({ rawBody: BODY, owner: "test", deps: makeDeps([], spy.llm) });
    expect(spy.ttls).toEqual(["5m"]);
  });

  it("is rejected up front when the host offers no elicitation channel", async () => {
    await expect(
      executeRun({ rawBody: BODY, owner: "test", deps: makeDeps([needsHuman]) }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
