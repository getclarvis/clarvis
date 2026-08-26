import { describe, it, expect } from "../bun-test.ts";
import { validateDelegateTaskArgs } from "../../src/runtime/subagents/delegate-task.ts";
import { resolveSubagentProfiles } from "../../src/runtime/subagents/subagent-profiles.ts";
import {
  buildRunSubagentInput,
  type SubagentRunContext,
} from "../../src/runtime/subagents/delegate-task.ts";
import { DELEGATE_TASK_MAX_CHARS, loadEnv } from "@clarvis/capability";

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

describe("validateDelegateTaskArgs", () => {
  it("accepts a non-empty task + title", () => {
    const single = resolveSubagentProfiles(
      [{ name: "solo", model: "anthropic/x", base_prompt: "go", tools: [] }],
      providers,
      env,
    );
    const r = validateDelegateTaskArgs({ title: "w", task: "do the thing" }, { profiles: single });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.title).toBe("w");
      expect(r.task).toBe("do the thing");
    }
  });

  it("rejects a missing/empty task", () => {
    expect(validateDelegateTaskArgs({ title: "w", task: "" }, { profiles }).ok).toBe(false);
    expect(validateDelegateTaskArgs({ title: "w" }, { profiles }).ok).toBe(false);
    expect(validateDelegateTaskArgs(null, { profiles }).ok).toBe(false);
    expect(validateDelegateTaskArgs({ title: "w", task: 42 }, { profiles }).ok).toBe(false);
  });

  it("accepts the exact task ceiling and rejects one Unicode character above it", () => {
    const single = resolveSubagentProfiles(
      [{ name: "solo", model: "anthropic/x", base_prompt: "go", tools: [] }],
      providers,
      env,
    );
    expect(
      validateDelegateTaskArgs(
        { title: "w", task: "😀".repeat(DELEGATE_TASK_MAX_CHARS) },
        { profiles: single },
      ).ok,
    ).toBe(true);
    const over = validateDelegateTaskArgs(
      { title: "w", task: "😀".repeat(DELEGATE_TASK_MAX_CHARS + 1) },
      { profiles: single },
    );
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.message).toContain(String(DELEGATE_TASK_MAX_CHARS));
  });

  it("rejects a missing/empty title", () => {
    expect(validateDelegateTaskArgs({ task: "do x" }, { profiles }).ok).toBe(false);
    expect(validateDelegateTaskArgs({ title: "", task: "do x" }, { profiles }).ok).toBe(false);
    const r = validateDelegateTaskArgs({ title: 7, task: "do x" }, { profiles });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.toLowerCase()).toContain("title");
  });

  it("normalizes a short title and rejects multiline or oversized labels", () => {
    const normalized = validateDelegateTaskArgs(
      { title: "  review   auth  ", task: "do x", profile: "researcher" },
      { profiles },
    );
    expect(normalized.ok).toBe(true);
    if (normalized.ok) expect(normalized.title).toBe("review auth");

    for (const title of ["review\nauth", "x".repeat(61)]) {
      const result = validateDelegateTaskArgs(
        { title, task: "do x", profile: "researcher" },
        { profiles },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("title");
    }
  });
});

describe("validateDelegateTaskArgs — subagent profiles", () => {
  it("accepts a registered profile selection and returns its name", () => {
    const r = validateDelegateTaskArgs(
      { title: "w", task: "x", profile: "researcher" },
      { profiles },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile).toBe("researcher");
  });

  it("falls back to default_profile when `profile` is omitted", () => {
    const r = validateDelegateTaskArgs(
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
    const r = validateDelegateTaskArgs({ title: "w", task: "x" }, { profiles: single });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile).toBe("solo");
  });

  it("rejects an omitted `profile` when several profiles exist and there is no default", () => {
    const r = validateDelegateTaskArgs({ title: "w", task: "x" }, { profiles });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message.toLowerCase()).toContain("profile");
      expect(r.message).toContain("researcher");
      expect(r.message).toContain("implementer");
    }
  });

  it("rejects an unknown profile and lists the registered names", () => {
    const r = validateDelegateTaskArgs({ title: "w", task: "x", profile: "nope" }, { profiles });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("nope");
      expect(r.message).toContain("researcher");
      expect(r.message).toContain("implementer");
    }
  });

  it("rejects a `profile` when no profiles are registered", () => {
    const r = validateDelegateTaskArgs({ title: "w", task: "x", profile: "researcher" });
    expect(r.ok).toBe(false);
  });
});

describe("validateDelegateTaskArgs — tracked task status guard", () => {
  /**
   * A hand-rolled fake `TaskTrackingPort`, standing in for whatever capability
   * tracks a run's work items. `validateDelegateTaskArgs`'s guard cares only
   * about the port's shape, not what backs it. `beforeSpawn`/`noteSpawned`/
   * `augmentDelegateTask` are unused by the guard itself but present to
   * satisfy the port's shape. Left untyped against `TaskTrackingPort` on
   * purpose, so each method's return type stays the plain `boolean` it
   * actually produces rather than the port's `Promise<boolean> | boolean`.
   */
  const trackerWith = () => {
    const items = [
      { id: "t1", title: "T", detail: "a", status: "pending" as const },
      { id: "t2", title: "T", detail: "b", status: "pending" as const },
    ] as Array<{
      id: string;
      title: string;
      detail: string;
      status: "pending" | "in_progress" | "returned" | "done" | "abandoned" | "failed";
    }>;
    const setStatus = (id: string, status: (typeof items)[number]["status"]): boolean => {
      const item = items.find((candidate) => candidate.id === id);
      if (item === undefined) return false;
      item.status = status;
      return true;
    };
    return {
      openTasks: () =>
        items.filter((item) => item.status !== "done" && item.status !== "abandoned"),
      getTask: (id: string) => items.find((item) => item.id === id),
      markSpawned: (id: string) => setStatus(id, "in_progress"),
      markFailed: (id: string, _error?: string) => setStatus(id, "failed"),
      beforeSpawn: async () => ({ kind: "ok" }) as const,
      noteSpawned: () => {},
      augmentDelegateTask: () => ({
        description: "tracked spawn",
        properties: { task_id: { type: "string" } },
      }),
      markReturned: (id: string) => setStatus(id, "returned"),
      markDone: (id: string) => setStatus(id, "done"),
      abandon: (id: string) => setStatus(id, "abandoned"),
    };
  };

  it("rejects re-spawning a done task and names the status", () => {
    const tracker = trackerWith();
    tracker.markSpawned("t1");
    tracker.markReturned("t1");
    tracker.markDone("t1");
    const r = validateDelegateTaskArgs(
      { title: "w", task: "x", task_id: "t1" },
      {
        tasks: tracker,
        profiles: profiles,
        defaultProfile: "researcher",
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("already done");
  });

  it("rejects re-spawning an abandoned task", () => {
    const tracker = trackerWith();
    tracker.abandon("t1");
    const r = validateDelegateTaskArgs(
      { title: "w", task: "x", task_id: "t1" },
      {
        tasks: tracker,
        profiles: profiles,
        defaultProfile: "researcher",
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("already abandoned");
  });

  it("allows re-spawning a failed task (the recovery path)", () => {
    const tracker = trackerWith();
    tracker.markSpawned("t1");
    tracker.markFailed("t1", "boom");
    const r = validateDelegateTaskArgs(
      { title: "w", task: "x", task_id: "t1" },
      {
        tasks: tracker,
        profiles: profiles,
        defaultProfile: "researcher",
      },
    );
    expect(r.ok).toBe(true);
  });

  it("allows spawning a returned task and a fresh pending task", () => {
    const tracker = trackerWith();
    tracker.markSpawned("t1");
    tracker.markReturned("t1");
    expect(
      validateDelegateTaskArgs(
        { title: "w", task: "x", task_id: "t1" },
        {
          tasks: tracker,
          profiles: profiles,
          defaultProfile: "researcher",
        },
      ).ok,
    ).toBe(true);
    expect(
      validateDelegateTaskArgs(
        { title: "w", task: "x", task_id: "t2" },
        {
          tasks: tracker,
          profiles: profiles,
          defaultProfile: "researcher",
        },
      ).ok,
    ).toBe(true);
  });

  it("requires task_id for tracked delegation", () => {
    const tracker = trackerWith();
    const r = validateDelegateTaskArgs(
      { title: "w", task: "x" },
      { tasks: tracker, profiles, defaultProfile: "researcher" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("task_id is required");
      expect(r.message).toContain("Use spawn_subagent for independent work");
    }
  });

  it("ignores surplus task_id for an independent spawn", () => {
    const tracker = trackerWith();
    const r = validateDelegateTaskArgs(
      { title: "w", task: "x", task_id: "independent", ignored: true },
      {
        tasks: tracker,
        requireTaskId: false,
        profiles,
        defaultProfile: "researcher",
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task_id).toBeUndefined();
  });

  it("rejects an unknown task_id", () => {
    const tracker = trackerWith();
    const r = validateDelegateTaskArgs(
      { title: "w", task: "x", task_id: "tX" },
      {
        tasks: tracker,
        profiles: profiles,
        defaultProfile: "researcher",
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("unknown task_id");
      expect(r.message).toContain("Use spawn_subagent for independent work");
      expect(r.message).not.toContain("every tracked task is already done or abandoned");
    }
  });
});
