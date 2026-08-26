import { describe, it, expect } from "../bun-test.ts";
import {
  AGENT_TOOL_WIRE_NAMES,
  READ_ONLY_AGENT_TOOL_WIRE_NAMES,
} from "../../src/runtime/tools/wire-names.ts";
import {
  AGENT_TOOL_NAMES,
  EDIT_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
} from "../../src/runtime/tools/builtin/names.ts";

describe("AGENT_TOOL_WIRE_NAMES", () => {
  it("stays in sync with the tool names @clarvis/tools actually registers", () => {
    expect([...AGENT_TOOL_WIRE_NAMES].sort()).toEqual([...AGENT_TOOL_NAMES].sort());
  });
});

describe("READ_ONLY_TOOL_NAMES", () => {
  it("matches the eager engine vocabulary without loading tools from the main entry", () => {
    expect([...READ_ONLY_AGENT_TOOL_WIRE_NAMES].sort()).toEqual([...READ_ONLY_TOOL_NAMES].sort());
  });

  it("partitions the coding surface with EDIT_TOOL_NAMES, with no overlap or gap", () => {
    expect([...READ_ONLY_TOOL_NAMES, ...EDIT_TOOL_NAMES].sort()).toEqual(
      [...AGENT_TOOL_NAMES].sort(),
    );
    for (const name of READ_ONLY_TOOL_NAMES) expect(EDIT_TOOL_NAMES).not.toContain(name);
  });

  it("excludes shell and the monitors, which observe and mutate through one entry point", () => {
    expect(READ_ONLY_TOOL_NAMES).not.toContain("shell");
    expect(READ_ONLY_TOOL_NAMES).not.toContain("monitor_start");
  });
});
