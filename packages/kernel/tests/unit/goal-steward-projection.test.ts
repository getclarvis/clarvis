import { describe, expect, it } from "bun:test";
import type { GoalRecord } from "@clarvis/goal";
import { applyGoalControl } from "@clarvis/goal";
import { buildStewardConversationFrame } from "../../src/goals/steward-projection.ts";

function goal(): GoalRecord {
  return applyGoalControl(
    undefined,
    {
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Ship the calculator",
        limits: { max_net_tokens: 1000 },
      },
    },
    { session_id: "session", new_goal_id: "goal", now: 1, physically_busy: false },
  ).state.current!;
}

describe("Steward conversational projection", () => {
  it("includes the Goal contract and selected turns, not tool dumps or global instructions", () => {
    const record = goal();
    record.candidate = {
      objective_revision: 1,
      execution_id: "run",
      summary: "The calculator adds two numbers.",
      assessments: [
        {
          criterion_id: "objective",
          kind: "qualitative",
          justification: "Verified in the browser",
          evidence: [],
        },
      ],
    };
    const { frame } = buildStewardConversationFrame({
      goal: record,
      attempt: { mode: "text", text: "The calculator adds two numbers." },
      operatorRequest: "Build a browser calculator",
      corrections: [{ text: "Keep it a single HTML file" }],
      dialogue: [
        { speaker: "steward", kind: "question", text: "Did addition work in the browser?" },
        { speaker: "work_agent", kind: "answer", text: "Yes; the UI added 2 and 3." },
      ],
    });
    const parsed = JSON.parse(frame) as Record<string, unknown>;
    expect(parsed.definition).toMatchObject({ objective: "Ship the calculator" });
    expect(parsed.operator_request).toEqual({
      origin: "operator",
      text: "Build a browser calculator",
    });
    expect(parsed.operator_corrections).toEqual([
      { origin: "operator", text: "Keep it a single HTML file" },
    ]);
    expect(parsed.report).toMatchObject({ summary: "The calculator adds two numbers." });
    expect(parsed.proposed_final).toBeUndefined();
    expect(parsed.dialogue).toHaveLength(2);
    expect(parsed).not.toHaveProperty("command_evidence");
    expect(parsed).not.toHaveProperty("evidence_details");
    expect(parsed).not.toHaveProperty("delegation_evidence");
    expect(parsed).not.toHaveProperty("workflow_history");
    expect(parsed).not.toHaveProperty("evidence_manifest");
    expect(frame).not.toContain("AGENTS.md");
    expect(frame).not.toContain("tool_result");
  });
});
