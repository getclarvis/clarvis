import { expect, test } from "bun:test";
import { createGoalFileHostFixture } from "../helpers/goal-file-host.ts";

test("goal work leaves memory off when no run selects it", async () => {
  const fixture = await createGoalFileHostFixture({ memory: true });
  try {
    fixture.setResponder(() =>
      Promise.resolve({
        name: "update_goal",
        arguments: { update: { action: "blocked", reason: "Await operator input" } },
      }),
    );
    await fixture.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Await operator input",
        limits: { max_net_tokens: 10000 },
      },
    });
    await fixture.until(() => fixture.host.stats().runs === 0);
    expect(fixture.requests).toHaveLength(1);
    expect((await fixture.client.memory.jobs()).jobs).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
