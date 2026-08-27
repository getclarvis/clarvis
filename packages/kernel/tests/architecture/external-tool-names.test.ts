import { describe, it, expect } from "bun:test";
import {
  EXTERNAL_TOOL_NAMES,
  EXTERNAL_TOOLS_WITHOUT_COUNTERPART,
  normalizeToolName,
} from "@clarvis/capability";
import { tools } from "@clarvis/tools";

/**
 * Tools a capability contributes rather than the workspace tool set, named here
 * with their owner so a rename shows up as a failure in this file.
 *
 * `delegate_task` is the engine's delegation capability and `load_skill` is
 * contributed by the optional skills capability. `@clarvis/tools` knows
 * nothing about either, so they cannot be checked against the registry below
 * and are listed instead.
 */
const CAPABILITY_TOOLS = new Set(["delegate_task", "load_skill"]);

describe("the external dialect's tool names name tools that exist", () => {
  const known = new Set(tools.map((tool) => tool.name));
  const normalizedKnown = new Set(tools.map((tool) => normalizeToolName(tool.name)));

  it("maps every foreign name onto a tool this host actually dispatches", () => {
    const unmapped = Object.entries(EXTERNAL_TOOL_NAMES).filter(
      ([, target]) => !known.has(target) && !CAPABILITY_TOOLS.has(target),
    );
    expect(unmapped).toEqual([]);
  });

  it("does not claim a counterpart is missing for a name this host has", () => {
    const contradicted = [...EXTERNAL_TOOLS_WITHOUT_COUNTERPART].filter((name) =>
      normalizedKnown.has(name),
    );
    expect(contradicted).toEqual([]);
  });

  it("keeps the capability allowlist honest: nothing on it belongs to the tool registry", () => {
    const redundant = [...CAPABILITY_TOOLS].filter((name) => known.has(name));
    expect(redundant).toEqual([]);
  });
});
