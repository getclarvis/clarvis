import { describe, expect, it } from "bun:test";
import type { ElicitationRelay } from "@clarvis/mcp-client";
import { ElicitRequestSchema, ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";

describe("MCP SDK elicitation compatibility", () => {
  it("accepts the exact request and Clarvis relay response used by the client", async () => {
    const request = ElicitRequestSchema.parse({
      method: "elicitation/create",
      params: {
        message: "Q?",
        requestedSchema: {
          type: "object",
          properties: { response: { type: "string" } },
          required: ["response"],
        },
      },
    });
    const signal = new AbortController().signal;
    const relay: ElicitationRelay = {
      handle: async (params, receivedSignal) => {
        expect(params).toBe(request.params);
        expect(receivedSignal).toBe(signal);
        return { action: "accept", content: { response: "yes" } };
      },
    };

    const result = ElicitResultSchema.parse(await relay.handle(request.params, signal));
    expect(request.method).toBe("elicitation/create");
    expect(result).toEqual({ action: "accept", content: { response: "yes" } });
  });
});
