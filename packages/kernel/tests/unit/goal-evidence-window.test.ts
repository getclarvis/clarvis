import { describe, expect, it } from "bun:test";
import { selectGoalEvidence } from "../../src/goals/evidence-window.ts";
import type { Observation } from "../../src/goals/evidence.ts";

const receipt = (id: string, subject = id, successful = true): Observation => ({
  id,
  executionId: "entry",
  tool: "shell",
  argumentsDigest: subject,
  resultDigest: successful ? "ok" : "failed",
  successful,
  description: "Synthetic verification",
});
const select = (events: Observation[], pinned: string[] = [], limit = 512) =>
  selectGoalEvidence({
    replay: () => events,
    pinned,
    limit,
    activity: {
      execution: "entry",
      fingerprint: (item) => (item.successful ? item.argumentsDigest : undefined),
    },
  });

describe("Goal evidence identity isolation", () => {
  it("withholds conflicting pinned proof without withholding independent evidence", () => {
    const result = select(
      [receipt("conflict"), receipt("independent"), receipt("conflict", "conflict", false)],
      ["conflict"],
    );
    expect(result.observations.map((item) => item.id)).toEqual(["independent"]);
    expect(result.activityUnavailable).toBe(true);
  });

  it("fences both subjects of an ambiguous identity against earlier successes", () => {
    const result = select([
      receipt("old-a", "a"),
      receipt("old-b", "b"),
      receipt("ambiguous", "a"),
      receipt("ambiguous", "b", false),
      receipt("independent"),
    ]);
    expect(result.observations.map((item) => item.id)).toEqual(["independent"]);
  });

  it("retains conflict rejection across rotation and repeatable journal reads", () => {
    const events = [
      receipt("pinned"),
      ...Array.from({ length: 2048 }, (_, index) => receipt(`child-${index}`)),
      receipt("pinned", "pinned", false),
    ];
    const first = select(events, ["pinned"]);
    expect(first.observations.some((item) => item.id === "pinned")).toBe(false);
    expect(first.observations).toHaveLength(511);
    expect(first.activityUnavailable).toBe(true);
    expect(select(events, ["pinned"])).toEqual(first);
  });

  it("keeps identical replays idempotent without resurrecting an older success", () => {
    const first = receipt("first", "subject");
    const result = select([
      first,
      receipt("failure", "subject", false),
      first,
      receipt("independent"),
    ]);
    expect(result.observations.map((item) => item.id)).toEqual(["failure", "independent"]);
    expect(result.activityUnavailable).toBe(false);
  });
});
