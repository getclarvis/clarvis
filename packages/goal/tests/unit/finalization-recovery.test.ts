import { describe, expect, it } from "bun:test";
import {
  GOAL_RECOVERY_TRACE_KIND,
  goalRecoveryNote,
  type GoalRecoveryCause,
} from "../../src/finalization-recovery.ts";

/**
 * The one orientation every Goal finalize gate gives a premature final.
 *
 * @remarks This is the model-facing half of the recovery policy, so its wording is
 *   a contract rather than styling: it has to say the Goal cannot conclude yet, keep
 *   continuing and checkpointing as valid answers, and never attribute a decision to
 *   the Goal Steward — which a premature final can be answered without ever calling.
 *   The contributed trace kind is pinned here too, because the persisted evidence
 *   is only findable if the name never drifts.
 */
describe("goal finalization recovery orientation", () => {
  it("states that the Goal cannot conclude yet and leaves several ways forward", () => {
    const note = goalRecoveryNote("incomplete_candidate", []);
    expect(note).toContain("cannot conclude yet");
    expect(note).toContain("Continue the work");
    expect(note).toContain("checkpoint");
    expect(note).not.toContain("Steward");
    expect(note).not.toContain("blocked");
  });

  it.each([
    ["no_goal", "has not been created yet", "create_goal"],
    ["no_candidate", "no completion candidate has been recorded", "update_goal"],
    ["incomplete_candidate", "does not satisfy every current criterion", "update_goal"],
  ] as ReadonlyArray<[GoalRecoveryCause, string, string]>)(
    "names the %s cause with its own direction",
    (cause, missing, direction) => {
      const note = goalRecoveryNote(cause, ["Criterion criterion-01 needs evidence"]);
      expect(note).toContain(missing);
      expect(note).toContain(direction);
      expect(note).toContain("Criterion criterion-01 needs evidence");
    },
  );

  it("keeps the contributed trace kind under its own name", () => {
    expect(GOAL_RECOVERY_TRACE_KIND).toBe("goal_finalization_recovery");
  });
});
