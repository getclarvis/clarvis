import { describe, expect, it } from "../helpers/bun-test.ts";

import { activationForScope, systemSectionsFor } from "../../src/compose.ts";
import type { AgentIdentity, AgentScope, RunCapability } from "../../src/contract.ts";

const scope: AgentScope = { agent: "lead", entry: true, grants: [] };
const identity: AgentIdentity = { agent: "lead", entry: true, grants: [] };

function runCapability(name: string, over: Partial<RunCapability> = {}): RunCapability {
  return { name, forAgent: () => null, ...over };
}

describe("systemSectionsFor", () => {
  it("returns an empty list when no capabilities are registered", () => {
    expect(systemSectionsFor(undefined, identity)).toEqual([]);
  });

  it("keeps sections in registration order and drops the ones that decline", () => {
    const caps = [
      runCapability("a", { systemSection: () => "A" }),
      runCapability("b"),
      runCapability("c", { systemSection: () => undefined }),
      runCapability("d", { systemSection: () => "D" }),
    ];
    expect(systemSectionsFor(caps, identity)).toEqual(["A", "D"]);
  });

  it("passes the identity through to each capability", () => {
    const seen: AgentIdentity[] = [];
    const caps = [
      runCapability("a", {
        systemSection: (id) => {
          seen.push(id);
          return undefined;
        },
      }),
    ];
    systemSectionsFor(caps, { agent: "subagent", entry: false, grants: ["memory"] });
    expect(seen).toEqual([{ agent: "subagent", entry: false, grants: ["memory"] }]);
  });
});

describe("activationForScope", () => {
  it("bundles the per-agent capabilities and the system sections together", () => {
    const attached = { tools: [] };
    const caps = [
      runCapability("a", {
        systemSection: () => "A",
        forAgent: () => ({ attach: () => attached }),
      }),
      runCapability("b", { systemSection: () => "B" }),
    ];
    const activation = activationForScope(caps, scope);
    expect(activation.systemSections).toEqual(["A", "B"]);
    expect(activation.capabilities).toHaveLength(1);
  });
});
