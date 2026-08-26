import { describe, expect, it } from "bun:test";
import { createCapabilityServices } from "@clarvis/capability";
import { AGENT_REGISTRY_PORT } from "../../src/agent-registry-port.ts";
import { createAgentRegistry } from "../../src/registry.ts";

describe("AGENT_REGISTRY_PORT", () => {
  it("publishes the full supervision registry through capability services", () => {
    const services = createCapabilityServices();
    const registry = createAgentRegistry({
      limits: {
        bufferLines: 10,
        bufferBytes: 1000,
        maxTotalBufferBytes: 2000,
        pollMaxBytes: 100,
        awaitTimeoutMs: 100,
        maxLiveChildren: 1,
        maxRetainedChildren: 1,
        maxNoticesPerIteration: 1,
        maxConsecutiveFailedChildren: 1,
        finishNudges: 1,
      },
    });
    services.provide(AGENT_REGISTRY_PORT, registry);
    expect(services.get(AGENT_REGISTRY_PORT)).toBe(registry);
    expect(services.get(AGENT_REGISTRY_PORT)?.list()).toEqual([]);
  });
});
