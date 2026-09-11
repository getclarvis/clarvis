import { describe, it, expect } from "../bun-test.ts";
import { buildSubmitResultTool, SUBMIT_RESULT_TOOL_NAME } from "../../src/runtime/tools/index.ts";

const schema = { type: "object", properties: { x: { type: "string" } } };

describe("buildSubmitResultTool", () => {
  it("names the tool submit_result with a wire-safe (un-namespaced) name", () => {
    const t = buildSubmitResultTool(schema);
    expect(t.toolName).toBe(SUBMIT_RESULT_TOOL_NAME);
    expect(t.wireName).toBe("submit_result");
    expect(t.fullName).toBe("submit_result");
    expect(t.mcpName).toBe("");
  });

  it("uses the caller schema verbatim (by reference) as inputSchema", () => {
    const t = buildSubmitResultTool(schema);
    expect(t.inputSchema).toBe(schema);
  });

  it("carries an operational-only description (no domain content, Article III.3)", () => {
    const t = buildSubmitResultTool(schema);
    const desc = (t.description ?? "").toLowerCase();
    expect(desc).toContain("accepted submission ends the run");
    expect(desc).toContain("runtime gate rejects it");
    expect(desc).toContain("before retrying");
    expect(desc).not.toContain("exactly once");
    expect(desc).not.toMatch(/extract|plaintiff|legal|persona|domain/);
  });
});
