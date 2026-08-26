import { describe, expect, it } from "../bun-test.ts";
import { fakeAgentBuildContext, fakeAgentScope } from "../../src/runtime/capabilities/testing.ts";

describe("capability testing helpers", () => {
  it("builds overridable defaults whose policy callbacks are executable", () => {
    expect(fakeAgentScope({ agent: "lead" })).toMatchObject({
      agent: "lead",
      entry: true,
      grants: [],
    });

    const context = fakeAgentBuildContext();
    expect(context.toolProgress({ errText: null } as never)).toBeTrue();
    expect(context.toolProgress({ errText: "failed" } as never)).toBeFalse();
    expect(context.maybeCancelled()).toBeNull();
    expect(context.validateArgs).toBeFunction();
  });
});
