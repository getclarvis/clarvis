import { describe, expect, it } from "../bun-test.ts";
import type { ConnectionManager, Lease } from "@clarvis/mcp-client";
import type { RunRequest } from "@clarvis/capability";
import { openToolPool } from "../../src/runtime/open-tool-pool.ts";

const request: RunRequest = {
  messages: [{ role: "user", content: "go" }],
  servers: [{ name: "docs", transport: "stdio", command: "server" }],
  profiles: [{ name: "solo", model: "anthropic/model", tools: [], iteration_limit: 2 }],
  entry: "solo",
  providers: [{ name: "anthropic", kind: "anthropic" }],
  budget: { on_exceed: "stop", total_token_limit: 1_000 },
};

describe("openToolPool cancellation policy", () => {
  it("releases a lease acquired after the caller was already cancelled", async () => {
    let releases = 0;
    const lease: Lease = {
      conn: {
        name: "docs",
        transport: "stdio",
        status: "connected",
        callTool: async () => ({ ok: true, data: "ok" }),
        close: async () => {},
      },
      tools: [],
      release: async () => void (releases += 1),
    };
    const connections: ConnectionManager = {
      acquire: async () => lease,
      closeAll: async () => {},
    };
    const signal = AbortSignal.abort();

    const result = await openToolPool({
      request,
      connections,
      owner: "test",
      signal,
      relay: undefined,
      emptyUsage: () => ({ iterations_used: 0, elapsed_ms: 0, by_agent: [] }),
    });

    expect(result).toEqual({
      ok: false,
      response: {
        status: "cancelled",
        result: "",
        usage: { iterations_used: 0, elapsed_ms: 0, by_agent: [] },
      },
    });
    expect(releases).toBe(1);
  });
});
