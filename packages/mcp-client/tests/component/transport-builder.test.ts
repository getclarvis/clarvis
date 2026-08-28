import { describe, it, expect } from "bun:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { buildTransport, BunStdioClientTransport } from "@clarvis/mcp-client";
import { MissingEnvVarsError, type McpServerConfig } from "@clarvis/capability";
import { createRecordingLogger } from "../helpers/recording-logger.ts";

const tool = (t: Partial<McpServerConfig>): McpServerConfig => ({
  name: "x",
  transport: "stdio",
  ...t,
});

describe("buildTransport", () => {
  it("stdio → BunStdioClientTransport (command required)", () => {
    expect(
      buildTransport(tool({ transport: "stdio", command: "npx", args: ["a"] })),
    ).toBeInstanceOf(BunStdioClientTransport);
    expect(() => buildTransport(tool({ transport: "stdio" }))).toThrow(/command is required/);
  });

  it("http → StreamableHTTPClientTransport", () => {
    expect(
      buildTransport(tool({ transport: "http", url: "https://example.com/mcp" })),
    ).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it("sse → SSEClientTransport", () => {
    expect(
      buildTransport(tool({ transport: "sse", url: "https://example.com/sse" })),
    ).toBeInstanceOf(SSEClientTransport);
  });

  it("resolves a ${VAR} header from env at construct time", () => {
    process.env.CLARVIS_TEST_TOK_039 = "secret-value";
    try {
      const t = buildTransport(
        tool({
          transport: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer ${CLARVIS_TEST_TOK_039}" },
        }),
      );
      expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
    } finally {
      delete process.env.CLARVIS_TEST_TOK_039;
    }
  });

  it("throws when a ${VAR} header references an absent env var (connection fails, no literal sent)", () => {
    expect(() =>
      buildTransport(
        tool({
          transport: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer ${CLARVIS_DEFINITELY_ABSENT_039}" },
        }),
      ),
    ).toThrow(MissingEnvVarsError);
  });

  // Without a default, a stdio child inherits the host process's cwd, so an MCP
  // server that resolves relative paths is rooted wherever `clarvis` was
  // launched from rather than in the workspace it serves.
  describe("stdio working directory", () => {
    const paramsOf = (t: unknown): Record<string, unknown> =>
      (t as unknown as { parameters: Record<string, unknown> }).parameters;
    const cwdOf = (t: unknown): unknown => paramsOf(t).cwd;

    it("falls back to the defaultCwd when the server declares none", () => {
      const t = buildTransport(tool({ command: "node", args: [] }), process.env, "/ws");
      expect(cwdOf(t)).toBe("/ws");
    });

    it("lets an explicit server cwd win over the defaultCwd", () => {
      const t = buildTransport(
        tool({ command: "node", args: [], cwd: "/srv" }),
        process.env,
        "/ws",
      );
      expect(cwdOf(t)).toBe("/srv");
    });

    it("passes no cwd at all when neither is given, preserving host inheritance", () => {
      const t = buildTransport(tool({ command: "node", args: [] }));
      expect(cwdOf(t)).toBeUndefined();
      expect(Object.keys(paramsOf(t))).not.toContain("cwd");
    });
  });

  it("stdio resolves a ${VAR} env value and accepts cwd", () => {
    process.env.CLARVIS_TEST_ENV_039 = "secret-value";
    try {
      const t = buildTransport(
        tool({
          transport: "stdio",
          command: "node",
          args: ["-e", ""],
          env: { AUTH_TOKEN: "${CLARVIS_TEST_ENV_039}" },
          cwd: "/tmp",
        }),
      );
      expect(t).toBeInstanceOf(BunStdioClientTransport);
    } finally {
      delete process.env.CLARVIS_TEST_ENV_039;
    }
  });

  it("stdio throws when an env ${VAR} references an absent var", () => {
    expect(() =>
      buildTransport(
        tool({
          transport: "stdio",
          command: "node",
          env: { AUTH_TOKEN: "${CLARVIS_DEFINITELY_ABSENT_039}" },
        }),
      ),
    ).toThrow(MissingEnvVarsError);
  });

  it("preserves unrecognized placeholder text for a portable declaration", () => {
    const built = buildTransport(
      tool({
        transport: "stdio",
        command: "node",
        env: { LITERAL: "${NOT_A_PORTABLE_PLUGIN_VARIABLE}" },
        expandVariables: false,
      }),
    ) as unknown as { parameters: { env: Record<string, string> } };

    expect(built.parameters.env.LITERAL).toBe("${NOT_A_PORTABLE_PLUGIN_VARIABLE}");
    expect(() =>
      buildTransport(
        tool({
          transport: "http",
          url: "https://example.com/mcp",
          headers: { "X-Literal": "${NOT_A_PORTABLE_PLUGIN_VARIABLE}" },
          expandVariables: false,
        }),
      ),
    ).not.toThrow();
  });
});

describe("buildTransport url requirement", () => {
  it("hands the stdio transport the logger a refused frame is reported through", () => {
    const recording = createRecordingLogger();
    const built = buildTransport(tool({ command: "node", args: [] }), process.env, undefined, {
      logger: recording.logger,
    });
    expect((built as unknown as { parameters: { logger?: unknown } }).parameters.logger).toBe(
      recording.logger,
    );
  });

  it("wires a stderr sink onto the stdio transport it builds", () => {
    const seen: Array<[string, string]> = [];
    const built = buildTransport(tool({ command: "node", args: [] }), process.env, undefined, {
      onServerStderr: (mcp, line) => seen.push([mcp, line]),
      maxServerStderrBytes: 64,
    });
    const push = (built as unknown as { parameters: { onStderr?: (text: string) => void } })
      .parameters.onStderr;
    push?.("boom\n");
    expect(seen).toEqual([["x", "boom"]]);
  });

  it("flushes an unterminated final stderr line when the child's stream ends", async () => {
    const seen: Array<[string, string]> = [];
    const built = buildTransport(tool({ command: "node", args: [] }), process.env, undefined, {
      onServerStderr: (mcp, line) => seen.push([mcp, line]),
    });
    const reader = built as unknown as {
      readStderr(stream: ReadableStream<Uint8Array>): Promise<void>;
    };
    await reader.readStderr(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("fatal: API key unset"));
          controller.close();
        },
      }),
    );
    expect(seen).toEqual([["x", "fatal: API key unset"]]);
  });

  it("throws when an http tool omits its url", () => {
    expect(() => buildTransport({ name: "h", transport: "http" })).toThrow(
      /url is required for http transport/,
    );
  });

  it("throws when an sse tool omits its url", () => {
    expect(() => buildTransport({ name: "s", transport: "sse" })).toThrow(
      /url is required for sse transport/,
    );
  });
});
