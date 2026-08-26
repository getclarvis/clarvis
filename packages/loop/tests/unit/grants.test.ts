import { describe, it, expect } from "../bun-test.ts";
import { agentToolCaps } from "../../src/runtime/tools/builtin/grants.ts";

describe("agentToolCaps", () => {
  it("attaches nothing without a workspace grant", () => {
    expect(agentToolCaps([], "exec")).toEqual({
      canRead: false,
      canMutate: false,
      canExec: false,
    });
    expect(agentToolCaps(["unrelated_grant", "ask_user"], "exec")).toEqual({
      canRead: false,
      canMutate: false,
      canExec: false,
    });
    expect(agentToolCaps(undefined, "exec")).toEqual({
      canRead: false,
      canMutate: false,
      canExec: false,
    });
  });

  it("read_workspace grants read only", () => {
    expect(agentToolCaps(["read_workspace"], "exec")).toEqual({
      canRead: true,
      canMutate: false,
      canExec: false,
    });
  });

  it("edit_workspace implies read; run_commands implies edit+read", () => {
    expect(agentToolCaps(["edit_workspace"], "exec")).toEqual({
      canRead: true,
      canMutate: true,
      canExec: false,
    });
    expect(agentToolCaps(["run_commands"], "exec")).toEqual({
      canRead: true,
      canMutate: true,
      canExec: true,
    });
  });

  it("clamps by the operator ceiling", () => {
    expect(agentToolCaps(["run_commands"], "none")).toEqual({
      canRead: false,
      canMutate: false,
      canExec: false,
    });
    expect(agentToolCaps(["run_commands"], "read")).toEqual({
      canRead: true,
      canMutate: false,
      canExec: false,
    });
    expect(agentToolCaps(["run_commands"], "edit")).toEqual({
      canRead: true,
      canMutate: true,
      canExec: false,
    });
  });
});
