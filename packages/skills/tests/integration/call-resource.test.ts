import { describe, expect, it } from "bun:test";
import { handleReadSkillResourceCall, SKILL_RESOURCE_MAX_CHARS } from "@clarvis/skills/capability";
import { makeTrace } from "../helpers/capability-fakes.ts";
import { fakeSkills, resourceCall, validateArgs } from "../helpers/call-fixtures.ts";

describe("handleReadSkillResourceCall", () => {
  it("degrades to a tool error when the resolved resource cannot be read", () => {
    const res = handleReadSkillResourceCall({
      call: resourceCall({
        arguments: { name: "alpha", resource: "scripts/run.sh", offset: 0 },
      }),
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
    const res = handleReadSkillResourceCall({
      call: resourceCall({
        arguments: { name: "alpha", resource: "references/note.md", offset: 0 },
      }),
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
    const res = handleReadSkillResourceCall({
      call: resourceCall({
        arguments: { name: "alpha", resource: "references/note.md", offset: 0 },
      }),
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

  it("returns a continuation offset for an oversized resource", () => {
    const res = handleReadSkillResourceCall({
      call: resourceCall({ arguments: { name: "alpha", resource: "big.txt", offset: 0 } }),
      skills: fakeSkills({
        readResourceChunk: (_name, _resource, offset) => ({
          text: "x".repeat(100),
          offset: offset ?? 0,
          nextOffset: 100,
          totalBytes: SKILL_RESOURCE_MAX_CHARS + 500,
        }),
      }),
      trace: makeTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs,
      maxResourceChars: 100,
    });
    expect(res.text).toContain("bytes 0-100 of 50500");
    expect(res.text).toContain("offset=100");
  });

  it("continues a large resource from the requested byte offset", () => {
    const res = handleReadSkillResourceCall({
      call: resourceCall({ arguments: { name: "alpha", resource: "big.txt", offset: 50 } }),
      skills: fakeSkills({
        readResourceChunk: (_name, _resource, offset) => ({
          text: "SECOND",
          offset: offset ?? 0,
          nextOffset: 56,
          totalBytes: 156,
        }),
      }),
      trace: makeTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs,
      maxResourceChars: 6,
    });

    expect(res.error).toBe(false);
    expect(res.text).toContain("bytes 50-56 of 156");
    expect(res.text).toContain("SECOND");
    expect(res.text).toContain("offset=56");
  });
});
