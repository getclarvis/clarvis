import { describe, expect, it } from "bun:test";
import { handleLoadSkillCall, SKILL_RESOURCE_MAX_CHARS } from "@clarvis/skills/capability";
import { makeTrace } from "../helpers/capability-fakes.ts";
import { call, fakeSkills, validateArgs } from "../helpers/call-fixtures.ts";

describe("handleLoadSkillCall", () => {
  it("degrades to a tool error when the resolved resource cannot be read", () => {
    const res = handleLoadSkillCall({
      call: call({ arguments: { name: "alpha", resource: "scripts/run.sh" } }),
      skills: fakeSkills({
        readResource: () => {
          throw new Error("resource disappeared");
        },
      }),
      trace: makeTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs,
    });
    expect(res.error).toBe(true);
    expect(res.text).toContain("could not read resource 'scripts/run.sh'");
  });

  it("returns the resource contents supplied by the provider", () => {
    const res = handleLoadSkillCall({
      call: call({ arguments: { name: "alpha", resource: "references/note.md" } }),
      skills: fakeSkills({ readResource: () => "REFERENCE CONTENT" }),
      trace: makeTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs,
    });
    expect(res.error).toBe(false);
    expect(res.text).toContain("Resource 'references/note.md' of skill 'alpha'");
    expect(res.text).toContain("REFERENCE CONTENT");
  });

  it("reads a resource without loading or retaining the skill body", () => {
    const res = handleLoadSkillCall({
      call: call({ arguments: { name: "alpha", resource: "references/note.md" } }),
      skills: fakeSkills({
        loadSkill: () => {
          throw new Error("body must stay undisclosed");
        },
        readResource: () => "REFERENCE ONLY",
      }),
      trace: makeTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs,
    });
    expect(res.error).toBe(false);
    expect(res.text).toContain("REFERENCE ONLY");
  });

  it("truncates an oversized resource at the configured cap", () => {
    const res = handleLoadSkillCall({
      call: call({ arguments: { name: "alpha", resource: "big.txt" } }),
      skills: fakeSkills({
        readResource: () => "x".repeat(SKILL_RESOURCE_MAX_CHARS + 500),
      }),
      trace: makeTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs,
      maxResourceChars: 100,
    });
    expect(res.text).toContain("[resource truncated at 100 characters]");
  });
});
