import { describe, expect, it } from "../bun-test.ts";
import { HOOKS_CAPABILITY_NAME } from "@clarvis/capability";
import { BUILTIN_CAPABILITY_NAMES } from "../../src/runtime/orchestrator.ts";
import { AGENT_TOOLS_CAPABILITY_NAME } from "../../src/runtime/capabilities/tools.ts";

/**
 * `run.composed` reports which built-ins were live, and the orchestrator is on
 * the engine's eager configuration path — so it cannot import the two modules
 * that own those names without dragging an optional package onto that path.
 * The names are duplicated there and pinned here so the eager path stays light
 * without allowing the copies to drift.
 */
describe("the built-in capability names the orchestrator duplicates", () => {
  it("matches the tools capability's own name", () => {
    expect(BUILTIN_CAPABILITY_NAMES.tools).toBe(AGENT_TOOLS_CAPABILITY_NAME);
  });

  it("matches the skills capability's own name", async () => {
    const { SKILLS_CAPABILITY_NAME } = await import("@clarvis/skills/capability");
    expect(BUILTIN_CAPABILITY_NAMES.skills).toBe(SKILLS_CAPABILITY_NAME);
  });

  it("takes the hooks name from the contract, which is never optional", () => {
    expect(BUILTIN_CAPABILITY_NAMES.hooks).toBe(HOOKS_CAPABILITY_NAME);
  });
});
