import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36abc";

describe("secret redaction — persisted trace", () => {
  it("redacts secrets in tool_call arguments and result returned by get_run", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            {
              name: "http.fetch",
              arguments: {
                url: "https://api.example.com",
                headers: { authorization: "Bearer abc.DEF-123_xyz" },
                key: "sk-proj-ABCDEFGH12345678",
              },
            },
          ],
        },
        { text: "done" },
      ],
    });
    const mcp = mockMCPFactory({
      http: {
        tools: [
          {
            name: "fetch",
            // Two JWT occurrences on purpose: `token=` is caught by the
            // key/value rule (which runs first and labels it generically), while
            // a bare one exercises the JWT shape rule. Both must vanish.
            call: () => `upstream said token=${JWT} and sk-proj-ZYXWVUTS87654321 and bare ${JWT}`,
          },
        ],
      },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "fetch it" }],
      servers: [{ name: "http", transport: "stdio", command: "node", args: ["-e", ""] }],
      entry: "solo",
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: ["http.fetch"],
          iteration_limit: 5,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
    });

    const detail = await harness.getRun(res.execution_id);
    expect(detail).not.toBeNull();
    const traceJson = JSON.stringify(detail!.trace);

    expect(traceJson).toContain("Bearer [redacted]");
    expect(traceJson).toContain("sk-[redacted]");
    expect(traceJson).toContain("[redacted-jwt]");

    expect(traceJson).not.toContain("abc.DEF-123_xyz");
    expect(traceJson).not.toContain("ABCDEFGH12345678");
    expect(traceJson).not.toContain("ZYXWVUTS87654321");
    expect(traceJson).not.toContain(JWT);
  });
});

describe("secret redaction — persisted request/response at rest", () => {
  it("redacts secrets in tool headers stored in request_json and returned by get_run", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    const mcp = mockMCPFactory({
      http: { tools: [{ name: "fetch", call: () => "ok" }] },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [
        {
          name: "http",
          transport: "http",
          url: "https://api.example.com/mcp",
          headers: {
            authorization: "Bearer abc.DEF-123_xyz",
            "x-api-key": "OPAQUEsecretValue123",
          },
        },
      ],
      entry: "solo",
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: ["http.fetch"],
          iteration_limit: 5,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
    });

    const detail = await harness.getRun(res.execution_id);
    expect(detail).not.toBeNull();
    const requestJson = JSON.stringify(detail!.request);

    expect(requestJson).toContain("[redacted]");
    expect(requestJson).not.toContain("abc.DEF-123_xyz");
    expect(requestJson).not.toContain("OPAQUEsecretValue123");
  });
});

describe("secret redaction — MCP connection error", () => {
  it("redacts credentials embedded in an MCP connection error message", async () => {
    const llm = new MockLLM({ script: [{ text: "unused" }] });
    const mcp = mockMCPFactory({
      broken: {
        tools: [],
        connectError: new Error(
          "connect failed for https://user:s3cr3tPass@host.example.com/mcp?token=SUPERSECRETVALUE",
        ),
      },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });

    const res = await harness.run({
      messages: [{ role: "user", content: "do" }],
      servers: [{ name: "broken", transport: "http", url: "https://host.example.com/mcp" }],
      entry: "solo",
      profiles: [
        { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
    });

    const body = res as unknown as { status: string; error: { code: string; message: string } };
    expect(body.status).toBe("error");
    expect(body.error.code).toBe("mcp_connection_failed");
    expect(body.error.message).toContain("https://[redacted]@host.example.com");
    expect(body.error.message).toContain("token=[redacted]");
    expect(body.error.message).not.toContain("s3cr3tPass");
    expect(body.error.message).not.toContain("SUPERSECRETVALUE");
  });
});
