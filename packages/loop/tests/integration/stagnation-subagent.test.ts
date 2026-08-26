import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const tools = [{ name: "fs", transport: "stdio", command: "node", args: ["-e", ""] }];

const stuckFactory = () =>
  mockMCPFactory({
    fs: {
      tools: [
        {
          name: "edit",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
          },
          call: () => "edited ok",
        },
        {
          name: "shell",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
          call: () => ({
            exit_code: 1,
            stdout: "FAIL: assertion error",
            stderr: "",
            timed_out: false,
          }),
        },
      ],
    },
  });

const editStep = (n: number) => ({
  toolCalls: [{ name: "fs.edit", arguments: { path: "/src/a.ts", content: `fix${n}` } }],
  usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0 },
});
const testStep = {
  toolCalls: [{ name: "fs.shell", arguments: { cmd: "npm test" } }],
  usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0 },
};

describe("Subagent stagnation guard", () => {
  it("does not treat repeated verification separated by edits as stagnation", async () => {
    const llm = new MockLLM({
      script: [
        editStep(1),
        testStep,
        editStep(2),
        testStep,
        editStep(3),
        testStep,
        {
          text: "reported the unchanged failure after trying distinct edits",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: stuckFactory() });

    const res = await harness.run({
      messages: [{ role: "user", content: "make the tests pass" }],
      servers: tools,
      entry: "solo",
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-haiku-4-5",
          tools: ["fs.edit", "fs.shell"],
          iteration_limit: 50,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 400_000, timeout_ms: 30000 },
    });

    expect(res.status).toBe("completed");
    expect((res as { error?: { code?: string } }).error?.code).not.toBe("stagnation_detected");
  });

  it("terminates when the subagent repeats the same verification consecutively", async () => {
    const llm = new MockLLM({ script: [testStep, testStep, testStep] });
    harness = await makeHarness({ llm, mcpFactory: stuckFactory() });

    const res = await harness.run({
      messages: [{ role: "user", content: "make the tests pass" }],
      servers: tools,
      entry: "solo",
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-haiku-4-5",
          tools: ["fs.edit", "fs.shell"],
          iteration_limit: 50,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 400_000, timeout_ms: 30000 },
    });

    expect(res.status).toBe("error");
    expect((res as { error?: { code?: string } }).error?.code).toBe("stagnation_detected");
    expect(llm.calls.length).toBeLessThanOrEqual(3);
  });

  it("does NOT trip when the test result changes each run (a healthy, progressing loop)", async () => {
    let n = 0;
    const changing = mockMCPFactory({
      fs: {
        tools: [
          {
            name: "edit",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
            call: () => "edited ok",
          },
          {
            name: "shell",
            inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
            call: () => {
              n += 1;
              return { exit_code: n < 3 ? 1 : 0, stdout: `run ${n}` };
            },
          },
        ],
      },
    });
    const llm = new MockLLM({
      script: [
        editStep(1),
        testStep,
        editStep(2),
        testStep,
        { text: "tests pass now", usage: { input_tokens: 3, output_tokens: 3 } },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: changing });

    const res = await harness.run({
      messages: [{ role: "user", content: "make the tests pass" }],
      servers: tools,
      entry: "solo",
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-haiku-4-5",
          tools: ["fs.edit", "fs.shell"],
          iteration_limit: 50,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 400_000, timeout_ms: 30000 },
    });

    expect(res.status).toBe("completed");
  });

  it("CLARVIS_DEFAULT_STAGNATION_THRESHOLD=0 disables the guard (byte-identical to before the feature)", async () => {
    const llm = new MockLLM({
      script: [
        editStep(1),
        testStep,
        editStep(2),
        testStep,
        editStep(3),
        testStep,
        { text: "done", usage: { input_tokens: 2, output_tokens: 2 } },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: stuckFactory(),
      env: { CLARVIS_DEFAULT_STAGNATION_THRESHOLD: "0" },
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "make the tests pass" }],
      servers: tools,
      entry: "solo",
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-haiku-4-5",
          tools: ["fs.edit", "fs.shell"],
          iteration_limit: 50,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 400_000, timeout_ms: 30000 },
    });

    expect(res.status).toBe("completed");
    expect((res as { error?: { code?: string } }).error?.code).not.toBe("stagnation_detected");
  });
});
