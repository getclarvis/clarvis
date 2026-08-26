import { describe, expect, it } from "bun:test";
import { handleReadyz } from "../../src/http/health-routes.ts";

describe("handleReadyz", () => {
  it("reports an unconstructed kernel before consulting dependencies", async () => {
    let consulted = false;
    const response = await handleReadyz({
      accepting: () => true,
      kernel: () => false,
      config: async () => {
        consulted = true;
        return true;
      },
      model: async () => true,
      mcp: () => true,
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not_ready", checks: { kernel: false } });
    expect(consulted).toBeFalse();
  });
});
