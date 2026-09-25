import { describe, it, expect } from "../bun-test.ts";
import { validateSpawnArgs } from "../../src/runtime/subagents/spawn-subagent.ts";
import { resolveSubagentProfiles } from "../../src/runtime/subagents/subagent-profiles.ts";
import {
  buildRunSubagentInput,
  type SubagentRunContext,
} from "../../src/runtime/subagents/spawn-subagent.ts";
import { TASK_BRIEF_MAX_CHARS, loadEnv } from "@clarvis/capability";

const env = loadEnv({});
const providers = [{ name: "anthropic", kind: "anthropic" as const }];

const profiles = resolveSubagentProfiles(
  [
    {
      name: "researcher",
      model: "anthropic/claude-haiku-4-5",
      base_prompt: "be a researcher",
      tools: ["docs.search"],
    },
    {
      name: "implementer",
      model: "anthropic/claude-haiku-4-5",
      base_prompt: "be an implementer",
      tools: ["docs.search", "rag.query"],
    },
  ],
  providers,
  env,
);

describe("buildRunSubagentInput — reasoning effort", () => {
  it("carries reasoningEffort from the resolved profile onto the subagent input", () => {
    const reg = resolveSubagentProfiles(
      [
        { name: "deep", model: "anthropic/m", tools: [], reasoning_effort: "high" },
        { name: "plain", model: "anthropic/m", tools: [] },
      ],
      providers,
      env,
    );
    const base = {
      task: "t",
      subagentInstanceId: "w1",
      llm: {},
      registry: {},
      ledger: {},
      maxIterations: 3,
      trace: {},
    } as unknown as SubagentRunContext;
    expect(buildRunSubagentInput(reg.get("deep")!, base).reasoningEffort).toBe("high");
    expect("reasoningEffort" in buildRunSubagentInput(reg.get("plain")!, base)).toBe(false);
  });
});

describe("validateSpawnArgs", () => {
  it("accepts a non-empty task + title", () => {
    const single = resolveSubagentProfiles(
      [{ name: "solo", model: "anthropic/x", base_prompt: "go", tools: [] }],
      providers,
      env,
    );
    const r = validateSpawnArgs({ title: "w", task: "do the thing" }, { profiles: single });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.title).toBe("w");
      expect(r.task).toBe("do the thing");
    }
  });

  it("rejects a missing/empty task", () => {
    expect(validateSpawnArgs({ title: "w", task: "" }, { profiles }).ok).toBe(false);
    expect(validateSpawnArgs({ title: "w" }, { profiles }).ok).toBe(false);
    expect(validateSpawnArgs(null, { profiles }).ok).toBe(false);
    expect(validateSpawnArgs({ title: "w", task: 42 }, { profiles }).ok).toBe(false);
  });

  it("accepts the exact task ceiling and rejects one Unicode character above it", () => {
    const single = resolveSubagentProfiles(
      [{ name: "solo", model: "anthropic/x", base_prompt: "go", tools: [] }],
      providers,
      env,
    );
    expect(
      validateSpawnArgs(
        { title: "w", task: "😀".repeat(TASK_BRIEF_MAX_CHARS) },
        { profiles: single },
      ).ok,
    ).toBe(true);
    const over = validateSpawnArgs(
      { title: "w", task: "😀".repeat(TASK_BRIEF_MAX_CHARS + 1) },
      { profiles: single },
    );
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.message).toContain(String(TASK_BRIEF_MAX_CHARS));
  });

  it("rejects a missing/empty title", () => {
    expect(validateSpawnArgs({ task: "do x" }, { profiles }).ok).toBe(false);
    expect(validateSpawnArgs({ title: "", task: "do x" }, { profiles }).ok).toBe(false);
    const r = validateSpawnArgs({ title: 7, task: "do x" }, { profiles });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.toLowerCase()).toContain("title");
  });

  it("normalizes a short title and rejects multiline or oversized labels", () => {
    const normalized = validateSpawnArgs(
      { title: "  review   auth  ", task: "do x", profile: "researcher" },
      { profiles },
    );
    expect(normalized.ok).toBe(true);
    if (normalized.ok) expect(normalized.title).toBe("review auth");

    for (const title of ["review\nauth", "x".repeat(61)]) {
      const result = validateSpawnArgs(
        { title, task: "do x", profile: "researcher" },
        { profiles },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("title");
    }
  });
});

describe("validateSpawnArgs — subagent profiles", () => {
  it("accepts a registered profile selection and returns its name", () => {
    const r = validateSpawnArgs({ title: "w", task: "x", profile: "researcher" }, { profiles });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile).toBe("researcher");
  });

  it("falls back to default_profile when `profile` is omitted", () => {
    const r = validateSpawnArgs(
      { title: "w", task: "x" },
      {
        profiles,
        defaultProfile: "implementer",
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile).toBe("implementer");
  });

  it("resolves the sole profile when none is named and there is exactly one", () => {
    const single = resolveSubagentProfiles(
      [{ name: "solo", model: "anthropic/x", base_prompt: "go", tools: [] }],
      providers,
      env,
    );
    const r = validateSpawnArgs({ title: "w", task: "x" }, { profiles: single });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile).toBe("solo");
  });

  it("rejects an omitted `profile` when several profiles exist and there is no default", () => {
    const r = validateSpawnArgs({ title: "w", task: "x" }, { profiles });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message.toLowerCase()).toContain("profile");
      expect(r.message).toContain("researcher");
      expect(r.message).toContain("implementer");
    }
  });

  it("rejects an unknown profile and lists the registered names", () => {
    const r = validateSpawnArgs({ title: "w", task: "x", profile: "nope" }, { profiles });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("nope");
      expect(r.message).toContain("researcher");
      expect(r.message).toContain("implementer");
    }
  });

  it("rejects a `profile` when no profiles are registered", () => {
    const r = validateSpawnArgs({ title: "w", task: "x", profile: "researcher" });
    expect(r.ok).toBe(false);
  });
});
