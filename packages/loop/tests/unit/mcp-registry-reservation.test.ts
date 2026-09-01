import { describe, it, expect } from "../bun-test.ts";
import type { Capability, MCPConnection } from "@clarvis/capability";

import { collectCapabilityToolMetadata } from "../../src/runtime/capability-tool-metadata.ts";
import { buildRegistry } from "../../src/runtime/tools/mcp-registry.ts";
import { createToolEffectPort } from "../../src/runtime/tools/tool-effect.ts";
import {
  AGENT_TOOL_WIRE_NAMES,
  BUILTIN_WIRE_NAMES,
  RESERVED_WIRE_NAMES,
} from "../../src/runtime/tools/wire-names.ts";

function fakeConn(name: string): MCPConnection {
  return {
    name,
    transport: "stdio",
    status: "connected",
    async callTool() {
      return { ok: true, data: {} };
    },
    async close() {},
  };
}

/**
 * `@clarvis/mcp-client` honours whatever reserved names it is handed; these
 * cases pin the half that package cannot see — that the engine hands it the
 * right ones. Without them, `buildRegistry` could be called with an empty set
 * and every assertion in the client's own suite would still pass.
 */
describe("the engine's reserved wire names reach the registry", () => {
  it("is derived from the built-in and coding tool lists, not hand-copied", () => {
    expect(RESERVED_WIRE_NAMES).toEqual([...BUILTIN_WIRE_NAMES, ...AGENT_TOOL_WIRE_NAMES]);
  });

  it.each([
    ["extension", "submit_result"],
    ["extension", "ask_user"],
    ["extension", "read_file"],
    ["extension", "spawn_subagent"],
    ["extension", "delegate_task"],
  ])("an MCP %s tool named %s never takes the built-in's name", (mcp, taken) => {
    const reg = buildRegistry(
      [{ conn: fakeConn(mcp), tools: [{ name: taken, inputSchema: { type: "object" } }] }],
      [],
    );
    expect(reg.tools[0]!.wireName).not.toBe(taken);
    expect(reg.resolve(`${mcp}.${taken}`)).not.toBeNull();
  });
});

/**
 * A capability's own tool names are no longer in the engine's vocabulary; they
 * reach the reserved set through `Capability.reservedWireNames` — an optional
 * list on `AgentLoopContribution`'s parent, unrelated to any particular
 * feature. This exercises `buildRegistry`'s own half of that seam with a
 * synthetic capability's names, standing in for whichever feature package
 * actually declares one at runtime.
 */
describe("registered capability tool metadata reaches the engine seams", () => {
  const ACTIVE_CAPABILITY = {
    name: "active_widgets",
    reservedWireNames: ["create_widget"],
    toolEffects: { create_widget: "mutate" },
    forRun: () => ({ name: "active_widgets", forAgent: () => null }),
  } satisfies Capability;
  const GATED_CAPABILITY = {
    name: "gated_widgets",
    reservedWireNames: ["revise_widget"],
    toolEffects: { revise_widget: "read" },
    forRun: () => null,
  } satisfies Capability;
  const metadata = collectCapabilityToolMetadata([ACTIVE_CAPABILITY, GATED_CAPABILITY]);

  it("collects declarations before activation, including a capability gated off for the run", () => {
    expect(ACTIVE_CAPABILITY.forRun()).not.toBeNull();
    expect(GATED_CAPABILITY.forRun()).toBeNull();
    expect(metadata).toEqual({
      reservedWireNames: ["create_widget", "revise_widget"],
      toolEffects: { create_widget: "mutate", revise_widget: "read" },
    });
  });

  it.each([
    ["extension", "create_widget"],
    ["extension", "revise_widget"],
  ])("an MCP %s tool named %s never takes the capability's name", (mcp, taken) => {
    const reg = buildRegistry(
      [{ conn: fakeConn(mcp), tools: [{ name: taken, inputSchema: { type: "object" } }] }],
      metadata.reservedWireNames,
    );
    expect(reg.tools[0]!.wireName).not.toBe(taken);
    expect(reg.resolve(`${mcp}.${taken}`)).not.toBeNull();
  });

  it("feeds declared effects to the classifier and leaves an absent declaration unknown", () => {
    const effects = createToolEffectPort(metadata.toolEffects);
    expect(effects.effect("create_widget")).toBe("mutate");
    expect(effects.effect("revise_widget")).toBe("read");
    expect(effects.effect("inspect_widget")).toBe("unknown");
  });

  it("without the capability's names, the engine alone does not protect them", () => {
    const reg = buildRegistry(
      [
        {
          conn: fakeConn("extension"),
          tools: [{ name: "create_widget", inputSchema: { type: "object" } }],
        },
      ],
      [],
    );
    expect(reg.tools[0]!.wireName).toBe("create_widget");
  });
});
