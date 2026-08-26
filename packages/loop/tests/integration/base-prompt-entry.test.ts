import { describe, it, expect } from "../bun-test.ts";
import { executeRun, type ExecuteRunDeps } from "../../src/runtime/execute-run.ts";
import { loadEnv } from "@clarvis/capability";
import { MockLLM, mockConnections, mockMCPFactory } from "./_fixtures.ts";
import { makeTestTraceStore } from "../contract/_helpers.ts";
import { ENV_SECTION } from "../env-section.ts";

const BASE = {
  messages: [{ role: "user", content: "What is the capital of France?" }],
  servers: [],
  providers: [{ name: "anthropic", kind: "anthropic" }],
  budget: { on_exceed: "stop", total_token_limit: 1000 },
};

function deps(llm: MockLLM): ExecuteRunDeps {
  return {
    env: loadEnv({}),
    llm,
    connections: mockConnections(mockMCPFactory({})),
    traceStore: makeTestTraceStore(),
    workspaceRoot: process.cwd(),
  };
}

describe("entry profile base_prompt", () => {
  it("prepends base_prompt as the first system message seen by the model", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    await executeRun({
      rawBody: {
        ...BASE,
        entry: "solo",
        profiles: [
          {
            name: "solo",
            model: "anthropic/x",
            tools: [],
            iteration_limit: 3,
            base_prompt: "PERSONA_SENTINEL",
          },
        ],
      },
      owner: "o",
      deps: deps(llm),
    });

    const messages = llm.calls[0]!.messages;
    expect(messages[0]).toEqual({
      role: "system",
      content: `${ENV_SECTION(process.cwd())}\n\nPERSONA_SENTINEL`,
    });
  });

  it("injects no system message when the entry profile declares no base_prompt", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    await executeRun({
      rawBody: {
        ...BASE,
        entry: "solo",
        profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
      },
      owner: "o",
      deps: deps(llm),
    });

    const messages = llm.calls[0]!.messages;
    expect(messages[0]).toEqual({
      role: "system",
      content: `${ENV_SECTION(process.cwd())}`,
    });
  });

  it("prepends base_prompt for a Lead entry (an agent with can_spawn)", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    await executeRun({
      rawBody: {
        ...BASE,
        entry: "lead",
        profiles: [
          {
            name: "lead",
            model: "anthropic/x",
            tools: [],
            iteration_limit: 5,
            base_prompt: "LEAD_PERSONA",
            can_spawn: ["w"],
            default_spawn: "w",
          },
          { name: "w", model: "anthropic/x", tools: [], iteration_limit: 5 },
        ],
      },
      owner: "o",
      deps: deps(llm),
    });

    const messages = llm.calls[0]!.messages;
    expect(messages[0]).toEqual({
      role: "system",
      content: `${ENV_SECTION(process.cwd())}\n\nLEAD_PERSONA`,
    });
  });
});
