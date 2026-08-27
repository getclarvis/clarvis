import { describe, it, expect } from "../helpers/bun-test.ts";
import { z } from "zod";
import {
  hookSchema,
  EXTERNAL_TOOL_NAMES,
  EXTERNAL_TOOLS_WITHOUT_COUNTERPART,
  normalizeToolName,
  HOOK_DEFAULT_TIMEOUT_MS,
  GATE_HOOK_EVENTS,
  OBSERVER_HOOK_EVENTS,
  CONTEXT_HOOK_EVENTS,
  COMPACTION_HOOK_EVENTS,
  PROMPT_HOOK_EVENTS,
  HOOKS_CAPABILITY_NAME,
  MAX_HOOK_COMMAND_CHARS,
  MAX_HOOK_MATCH_PATTERNS,
  MAX_HOOK_PATTERN_CHARS,
  MAX_HOOK_TIMEOUT_MS,
} from "../../src/index.ts";

const base = { command: "echo hi" };

function issues(value: unknown): { path: string; message: string }[] {
  const parsed = hookSchema.safeParse(value);
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

describe("hookSchema — event groups", () => {
  it("accepts every declared event", () => {
    for (const event of [
      ...GATE_HOOK_EVENTS,
      ...OBSERVER_HOOK_EVENTS,
      ...CONTEXT_HOOK_EVENTS,
      ...COMPACTION_HOOK_EVENTS,
      ...PROMPT_HOOK_EVENTS,
    ]) {
      expect(hookSchema.safeParse({ ...base, event }).success).toBe(true);
    }
  });

  it("keeps pre_compact out of the observer group, whose output is discarded", () => {
    expect([...OBSERVER_HOOK_EVENTS]).not.toContain("pre_compact");
    expect([...COMPACTION_HOOK_EVENTS]).toEqual(["pre_compact"]);
    expect([...CONTEXT_HOOK_EVENTS]).not.toContain("pre_compact");
  });

  it("rejects an unknown event, listing the legal ones", () => {
    expect(issues({ ...base, event: "on_vibes" })[0]?.message).toContain(
      "hooks[].event must be one of",
    );
  });

  it("rejects an unknown key outright", () => {
    expect(hookSchema.safeParse({ ...base, event: "run_start", nope: 1 }).success).toBe(false);
  });

  it("requires a non-empty command", () => {
    expect(issues({ event: "run_start", command: "" })[0]?.message).toBe(
      "hooks[].command must be a non-empty string",
    );
  });

  it("bounds command size before it enters configuration state", () => {
    expect(
      hookSchema.safeParse({
        event: "run_start",
        command: "x".repeat(MAX_HOOK_COMMAND_CHARS + 1),
      }).success,
    ).toBe(false);
  });
});

describe("hookSchema — match is tool-scoped", () => {
  it("accepts a match on the two tool events", () => {
    for (const event of ["pre_tool_use", "post_tool_use"]) {
      expect(hookSchema.safeParse({ ...base, event, match: { tool: "shell" } }).success).toBe(true);
    }
  });

  it("rejects a match on any other event, naming it", () => {
    const found = issues({ ...base, event: "run_start", match: { tool: "shell" } });
    expect(found[0]?.path).toBe("match");
    expect(found[0]?.message).toContain("'run_start'");
  });

  it("rejects an empty match object", () => {
    expect(issues({ ...base, event: "pre_tool_use", match: {} })[0]?.message).toBe(
      "hooks[].match must set tool and/or args",
    );
  });

  it("accepts an array of tool patterns and a bare args filter", () => {
    expect(
      hookSchema.safeParse({ ...base, event: "pre_tool_use", match: { tool: ["a", "b"] } }).success,
    ).toBe(true);
    expect(
      hookSchema.safeParse({ ...base, event: "pre_tool_use", match: { args: { path: "^/tmp" } } })
        .success,
    ).toBe(true);
  });

  it("rejects an args pattern that is not a valid regular expression, naming the field", () => {
    const found = issues({
      ...base,
      event: "pre_tool_use",
      match: { args: { command: "([unclosed" } },
    });
    expect(found[0]?.path).toBe("match.args.command");
    expect(found[0]?.message).toContain("not a valid regular expression");
  });

  it("bounds matcher count and source size before compiling regexes", () => {
    expect(
      hookSchema.safeParse({
        ...base,
        event: "pre_tool_use",
        match: { tool: Array.from({ length: MAX_HOOK_MATCH_PATTERNS + 1 }, () => "*") },
      }).success,
    ).toBe(false);
    expect(
      hookSchema.safeParse({
        ...base,
        event: "pre_tool_use",
        match: { args: { command: "x".repeat(MAX_HOOK_PATTERN_CHARS + 1) } },
      }).success,
    ).toBe(false);
  });
});

describe("hookSchema — on_failure", () => {
  it("accepts deny on every gate event", () => {
    for (const event of GATE_HOOK_EVENTS) {
      expect(hookSchema.safeParse({ ...base, event, on_failure: "deny" }).success).toBe(true);
    }
  });

  it("rejects deny on an observer event, which always passes", () => {
    const found = issues({ ...base, event: "run_start", on_failure: "deny" });
    expect(found[0]?.path).toBe("on_failure");
    expect(found[0]?.message).toContain("always passes");
  });

  it("accepts pass on an observer event", () => {
    expect(hookSchema.safeParse({ ...base, event: "run_start", on_failure: "pass" }).success).toBe(
      true,
    );
  });

  it("rejects on_failure entirely on an offering event, whichever value", () => {
    for (const event of ["session_start", "pre_compact"]) {
      for (const on_failure of ["pass", "deny"]) {
        const found = issues({ ...base, event, on_failure });
        expect(found[0]?.path).toBe("on_failure");
        expect(found[0]?.message).toContain("contributes nothing");
      }
    }
  });

  it("rejects a value outside the two-member enum", () => {
    expect(issues({ ...base, event: "pre_tool_use", on_failure: "explode" })[0]?.message).toBe(
      "hooks[].on_failure must be 'pass' | 'deny'",
    );
  });
});

describe("hookSchema — timeout_ms", () => {
  it("accepts a positive integer and rejects zero, negatives and fractions", () => {
    expect(hookSchema.safeParse({ ...base, event: "run_start", timeout_ms: 1 }).success).toBe(true);
    for (const timeout_ms of [0, -1, 1.5]) {
      expect(hookSchema.safeParse({ ...base, event: "run_start", timeout_ms }).success).toBe(false);
    }
    expect(
      hookSchema.safeParse({
        ...base,
        event: "run_start",
        timeout_ms: MAX_HOOK_TIMEOUT_MS + 1,
      }).success,
    ).toBe(false);
  });

  it("generates its description from the timeout table, so the two cannot drift", () => {
    const json = z.toJSONSchema(hookSchema, { io: "input" }) as {
      properties?: Record<string, { description?: string }>;
    };
    const described = json.properties?.timeout_ms?.description ?? "";
    for (const value of [
      HOOK_DEFAULT_TIMEOUT_MS.tool,
      HOOK_DEFAULT_TIMEOUT_MS.gate,
      HOOK_DEFAULT_TIMEOUT_MS.run_end,
      HOOK_DEFAULT_TIMEOUT_MS.observer,
    ]) {
      expect(described).toContain(String(value));
    }
  });
});

describe("the hooks vocabulary", () => {
  it("names the capability once", () => {
    expect(HOOKS_CAPABILITY_NAME).toBe("hooks");
  });

  it("partitions the events into disjoint groups", () => {
    const all = [
      ...GATE_HOOK_EVENTS,
      ...OBSERVER_HOOK_EVENTS,
      ...CONTEXT_HOOK_EVENTS,
      ...COMPACTION_HOOK_EVENTS,
      ...PROMPT_HOOK_EVENTS,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it("gives the tool events a shorter budget than the gate events, since they fire per call", () => {
    expect(HOOK_DEFAULT_TIMEOUT_MS.tool).toBeLessThan(HOOK_DEFAULT_TIMEOUT_MS.gate);
    expect(HOOK_DEFAULT_TIMEOUT_MS.run_end).toBeLessThan(HOOK_DEFAULT_TIMEOUT_MS.observer);
  });
});

describe("the external dialect's tool names", () => {
  it("normalizes away capitalization and separators", () => {
    expect(normalizeToolName("MultiEdit")).toBe("multiedit");
    expect(normalizeToolName("multi_edit")).toBe("multiedit");
    expect(normalizeToolName("multi-edit")).toBe("multiedit");
    expect(normalizeToolName("")).toBe("");
  });

  it("keys every entry by its own normalized form, so a lookup cannot miss", () => {
    for (const key of Object.keys(EXTERNAL_TOOL_NAMES)) {
      expect(normalizeToolName(key)).toBe(key);
    }
    for (const key of EXTERNAL_TOOLS_WITHOUT_COUNTERPART) {
      expect(normalizeToolName(key)).toBe(key);
    }
  });

  it("maps the names a filter reaches for onto the ones this host dispatches", () => {
    expect(EXTERNAL_TOOL_NAMES[normalizeToolName("Bash")]).toBe("shell");
    expect(EXTERNAL_TOOL_NAMES[normalizeToolName("Write")]).toBe("write_file");
    expect(EXTERNAL_TOOL_NAMES[normalizeToolName("Edit")]).toBe("edit_file");
    expect(EXTERNAL_TOOL_NAMES[normalizeToolName("MultiEdit")]).toBe("multi_edit");
    expect(EXTERNAL_TOOL_NAMES[normalizeToolName("Grep")]).toBe("grep");
    expect(EXTERNAL_TOOL_NAMES[normalizeToolName("Skill")]).toBe("load_skill");
  });

  it("never lists a name in both directions at once", () => {
    for (const key of Object.keys(EXTERNAL_TOOL_NAMES)) {
      expect(EXTERNAL_TOOLS_WITHOUT_COUNTERPART.has(key)).toBe(false);
    }
  });
});
