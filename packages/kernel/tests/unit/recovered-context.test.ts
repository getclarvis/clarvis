import { describe, expect, test } from "bun:test";
import type { PlanRef, RunDetail, RunEvent, RunResult } from "@clarvis/protocol";
import { buildRecoveredContext, buildSkillRunDigest } from "../../src/runs/recovered-context.ts";

const plan: PlanRef = {
  provider_key: "plugin:tracker",
  id: "APP-42",
  final_revision: 7,
  final_spec_revision: 2,
  status: "active",
  retention: "keep",
};
const decisions: RunEvent[] = [
  {
    type: "elicitation_resolved",
    at: 1,
    agent: "lead",
    question: " Which database? ",
    outcome: "accept",
    answer: " SQLite ",
  },
  {
    type: "elicitation_resolved",
    at: 2,
    agent: "lead",
    question: "Publish?",
    outcome: "decline",
  },
];

function interrupted(patch: Partial<RunDetail> = {}): RunDetail {
  return {
    execution_id: "skill-run",
    status: "failed",
    created_at: 1,
    messages: [],
    events: decisions,
    plan_ref: plan,
    ...patch,
  };
}

describe("host-owned recovered context", () => {
  test("preserves accepted decisions and the authoritative provider without reviving declined consent", () => {
    const context = buildRecoveredContext(decisions, plan, "markdown")!;
    expect(context).toContain("Which database? → SQLite");
    expect(context).not.toContain("Publish?");
    expect(context).toContain("Plan left active at revision 7");
    expect(context).toContain("ID: APP-42");
    expect(context).toContain("Select plugin:tracker again before read_plan");
    expect(context).not.toContain("Locator:");
    expect(context).not.toContain("undefined");
    expect(context).toContain("do not open another document as if it were the active plan");
  });

  test("keeps a locator as a hint and ignores completed plans or unanswered questions", () => {
    const context = buildRecoveredContext(
      [],
      { ...plan, path: "tracker://APP-42" },
      plan.provider_key,
    )!;
    expect(context).toContain("Locator: tracker://APP-42");
    expect(context).toContain("Read id APP-42 with read_plan before acting");
    expect(context).toContain("authoritative and may have changed");
    expect(buildRecoveredContext(decisions.slice(1), { ...plan, status: "completed" })).toBeNull();
    expect(buildRecoveredContext([{ ...decisions[0]!, answer: "" } as RunEvent])).toBeNull();
    expect(buildRecoveredContext([])).toBeNull();
  });

  test("a live skill result takes precedence over a stale stored result and names its producing agent", () => {
    const live: RunResult = {
      execution_id: "live",
      status: "completed",
      result: "Committed abc123",
    };
    const stored = interrupted({ result: { ...live, result: "older result" } });
    const digest = buildSkillRunDigest("commit", "coder", live, stored);
    expect(digest).toBe("[/commit → coder, exec live]\nCommitted abc123");
    expect(buildSkillRunDigest("commit", "coder", undefined, stored)).toContain("older result");
  });

  test("structured results are preserved and unrenderable results fall back to recoverable decisions", () => {
    const live: RunResult = {
      execution_id: "skill-run",
      status: "completed",
      result: { changed: ["app.ts"], checks: "passed" },
    };
    expect(buildSkillRunDigest("review", "reviewer", live, null)).toContain(
      '{"changed":["app.ts"],"checks":"passed"}',
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const result of ["", null, circular]) {
      const digest = buildSkillRunDigest("review", "reviewer", { ...live, result }, interrupted());
      expect(digest).toContain("Recovered context");
      expect(digest).toContain("Which database? → SQLite");
    }
  });

  test("an empty skill result reports its actual outcome without fabricating successful work", () => {
    expect(buildSkillRunDigest("review", "reviewer", undefined, null)).toBe(
      "[/review → reviewer] completed with no textual result.",
    );
    expect(
      buildSkillRunDigest(
        "review",
        "reviewer",
        undefined,
        interrupted({ events: [], plan_ref: undefined }),
      ),
    ).toContain("failed with no textual result.");
    expect(
      buildSkillRunDigest(
        "review",
        "reviewer",
        { execution_id: "cancelled", status: "cancelled", result: "  " },
        null,
      ),
    ).toContain("cancelled with no textual result.");
  });
});
