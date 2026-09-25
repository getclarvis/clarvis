import { expect, it } from "bun:test";
import { unavailableGoalService } from "../../src/goals/unavailable.ts";

it("keeps goal operations unavailable without an authenticated conversation host", async () => {
  const goals = unavailableGoalService("No conversation host");
  expect(await goals.availability()).toEqual({ available: false, reason: "No conversation host" });
  await expect(goals.get("session")).rejects.toMatchObject({ code: "unsupported" });
});
