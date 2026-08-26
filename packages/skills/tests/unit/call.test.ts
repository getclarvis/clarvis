import { describe, it, expect } from "bun:test";
import { handleLoadSkillCall, LOAD_SKILL_TOOL_NAME, loadSkillTool } from "../../src/capability.ts";
import { makeTrace } from "../helpers/capability-fakes.ts";
import { call, fakeSkills, validateArgs } from "../helpers/call-fixtures.ts";

function toolCallDetail(trace: ReturnType<typeof makeTrace>): unknown {
  return trace.entries().find((entry) => entry.kind === "tool_call")?.detail;
}

describe("handleLoadSkillCall", () => {
  it("reaches the declared schema rather than trusting the injected validator", () => {
    // Guards the move out of `@clarvis/loop`: the engine injects an Ajv-backed
    // validator this package cannot depend on, so the local fake must be handed
    // `loadSkillTool.inputSchema` (not a permissive stand-in) or every
    // argument-rejection case below would pass vacuously.
    const seen: unknown[] = [];
    const res = handleLoadSkillCall({
      call: call({ arguments: { name: "alpha" } }),
      skills: fakeSkills(),
      trace: makeTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs: (schema, args) => {
        seen.push(schema);
        return validateArgs(schema, args);
      },
    });
    expect(seen).toEqual([loadSkillTool.inputSchema]);
    expect(res.error).toBe(false);
  });

  it("rejects a missing name and records the failed tool_call", () => {
    const trace = makeTrace();
    const res = handleLoadSkillCall({
      call: call({ arguments: {} }),
      skills: fakeSkills(),
      trace,
      agent: "subagent",
      iteration: 1,
      validateArgs,
    });
    expect(res.error).toBe(true);
    expect(res.text).toContain("InputValidationError");
    const detail = toolCallDetail(trace);
    expect(detail).toMatchObject({
      name: LOAD_SKILL_TOOL_NAME,
      error: expect.anything(),
      call_id: "c1",
    });
    expect(trace.entries().some((e) => e.kind === "tool_call_started")).toBe(false);
  });

  it("rejects unknown argument keys via the declared schema", () => {
    const res = handleLoadSkillCall({
      call: call({ arguments: { name: "alpha", extra: 1 } }),
      skills: fakeSkills(),
      trace: makeTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs,
    });
    expect(res.error).toBe(true);
    expect(res.text).toContain("InputValidationError");
  });

  it("defaults absent call arguments to an empty object", () => {
    const res = handleLoadSkillCall({
      // Deliberately crosses the normalized provider boundary to pin the
      // defensive fallback for an older/foreign caller with no arguments.
      call: { id: "c1", name: LOAD_SKILL_TOOL_NAME, arguments: undefined as never },
      skills: fakeSkills(),
      trace: makeTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs,
    });
    expect(res.text).toContain("InputValidationError");
  });

  it("rejects an unknown skill and lists the available names", () => {
    const res = handleLoadSkillCall({
      call: call({ arguments: { name: "ghost" } }),
      skills: fakeSkills(),
      trace: makeTrace(),
      agent: "lead",
      iteration: 2,
      validateArgs,
    });
    expect(res.error).toBe(true);
    expect(res.text).toContain("unknown skill 'ghost'");
    expect(res.text).toContain("alpha, beta");
  });

  it("rejects a resource lookup before reading when the skill is unknown", () => {
    let reads = 0;
    const res = handleLoadSkillCall({
      call: call({ arguments: { name: "ghost", resource: "notes.md" } }),
      skills: fakeSkills({
        readResource: () => {
          reads += 1;
          return "unreachable";
        },
      }),
      trace: makeTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs,
    });

    expect(res.error).toBe(true);
    expect(res.text).toContain("unknown skill 'ghost'");
    expect(reads).toBe(0);
  });

  it("maps a lazy skill body read failure to a tool error", () => {
    const res = handleLoadSkillCall({
      call: call({ arguments: { name: "alpha" } }),
      skills: fakeSkills({
        loadSkill: () => {
          throw new Error("manifest grew past its bound");
        },
      }),
      trace: makeTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs,
    });
    expect(res.error).toBe(true);
    expect(res.text).toContain("could not load skill 'alpha'");
    expect(res.text).toContain("manifest grew past its bound");
  });

  it("returns the skill body plus a resource manifest and records success with the subagent id", () => {
    const trace = makeTrace();
    const res = handleLoadSkillCall({
      call: call({ arguments: { name: "alpha" } }),
      skills: fakeSkills(),
      trace,
      agent: "subagent",
      subagentInstanceId: "w1",
      iteration: 3,
      validateArgs,
    });
    expect(res.error).toBe(false);
    expect(res.text).toContain("ALPHA BODY");
    expect(res.text).toContain("scripts/run.sh (scripts)");
    const detail = toolCallDetail(trace);
    expect(detail).toMatchObject({
      error: null,
      subagent_instance_id: "w1",
      arguments: { name: "alpha" },
      call_id: "c1",
    });
    const started = trace.entries().find((entry) => entry.kind === "tool_call_started")?.detail;
    expect(started).toMatchObject({ name: LOAD_SKILL_TOOL_NAME, call_id: "c1" });
  });

  it("renders an empty body with a placeholder and no resource section", () => {
    const res = handleLoadSkillCall({
      call: call({ arguments: { name: "beta" } }),
      skills: fakeSkills(),
      trace: makeTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs,
    });
    expect(res.text).toContain("(this skill has an empty body)");
    expect(res.text).not.toContain("Bundled resources");
  });

  it("loads the skill body when resource names a sentinel or the skill's own manifest", () => {
    for (const resource of [
      " ",
      ". ",
      "/",
      "./",
      "SKILL.md",
      "./SKILL.md",
      ".agents/skills/alpha/SKILL.md",
      "/tmp/catalog/alpha/SKILL.md",
      ".agents\\skills\\alpha\\SKILL.md",
    ]) {
      const reads: string[] = [];
      const res = handleLoadSkillCall({
        call: call({ arguments: { name: "alpha", resource } }),
        skills: fakeSkills({
          readResource: (_name, rel) => {
            reads.push(rel);
            return "unreachable";
          },
        }),
        trace: makeTrace(),
        agent: "subagent",
        iteration: 1,
        validateArgs,
      });
      expect(res.error).toBe(false);
      expect(res.text).toContain("ALPHA BODY");
      expect(reads).toEqual([]);
    }
  });

  it("rejects a non-string / empty resource argument", () => {
    for (const resource of [42, ""]) {
      const res = handleLoadSkillCall({
        call: call({ arguments: { name: "alpha", resource } }),
        skills: fakeSkills(),
        trace: makeTrace(),
        agent: "subagent",
        iteration: 1,
        validateArgs,
      });
      expect(res.error).toBe(true);
      expect(res.text).toContain("InputValidationError");
    }
  });

  it("lists '(none)' when an unknown skill is requested against an empty catalog", () => {
    const res = handleLoadSkillCall({
      call: call({ arguments: { name: "ghost" } }),
      skills: fakeSkills({ listSkills: () => [], loadSkill: () => undefined }),
      trace: makeTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs,
    });
    expect(res.text).toContain("Available skills: (none)");
  });

  it("handles a non-Error thrown while reading a resource", () => {
    const res = handleLoadSkillCall({
      call: call({ arguments: { name: "alpha", resource: "scripts/run.sh" } }),
      skills: fakeSkills({
        readResource: () => {
          throw "raw string failure";
        },
      }),
      trace: makeTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs,
    });
    expect(res.error).toBe(true);
    expect(res.text).toContain("raw string failure");
  });

  it("surfaces a resource rejection (e.g. path escape) as a tool error", () => {
    const res = handleLoadSkillCall({
      call: call({ arguments: { name: "alpha", resource: "../escape" } }),
      skills: fakeSkills({
        readResource: () => {
          throw new Error("resolved path escapes the skill directory");
        },
      }),
      trace: makeTrace(),
      agent: "subagent",
      iteration: 1,
      validateArgs,
    });
    expect(res.error).toBe(true);
    expect(res.text).toContain("could not read resource '../escape'");
    expect(res.text).toContain("escapes the skill directory");
  });

  it("refuses to run at all when the host wires no argument validator", () => {
    // `load_skill` always declares a schema, and `openCallEnvelope` treats a
    // schema with no validator as a construction error rather than reporting
    // every malformed call as valid. Pins the branch that omits `validate`.
    expect(() =>
      handleLoadSkillCall({
        call: call({ arguments: { name: "alpha" } }),
        skills: fakeSkills(),
        trace: makeTrace(),
        agent: "subagent",
        iteration: 1,
      }),
    ).toThrow("supplied an argument schema with no validator");
  });
});
