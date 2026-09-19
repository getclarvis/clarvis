import { describe, expect, it } from "bun:test";
import type { GoalCreationInput, GoalRepository, GoalState } from "@clarvis/goal";
import type { Session } from "@clarvis/protocol";
import type { GoalEvidenceSource } from "../../src/goals/evidence.ts";
import { createGoalCreationPort } from "../../src/goals/creation-port.ts";
import { createCreationLifecycle } from "../../src/goals/creation-port-lifecycle.ts";

const session: Session = {
  id: "session",
  title: "Goal creation",
  project_id: "project",
  workspace: "workspace",
  created_at: 1,
  updated_at: 1,
  turns: [],
  totals: { input: 0, cached: 0, output: 0 },
};

const input: GoalCreationInput = {
  objective: "Deliver the requested result",
  criteria: [],
  constraints: [],
  exclusions: [],
  assumptions: [],
};

function repositoryFixture(options: { delay?: Promise<void> } = {}) {
  let state: GoalState | undefined;
  let transactions = 0;
  const repository: GoalRepository = {
    async read() {
      return structuredClone(state);
    },
    async transact(_sessionId, mutation) {
      transactions++;
      if (options.delay !== undefined) await options.delay;
      const result = mutation(structuredClone(state));
      state = result.state;
      return result.result;
    },
  };
  return { repository, state: () => state, transactions: () => transactions };
}

const evidence = {
  observe() {},
  generation: 0,
  async snapshot() {
    throw new Error("unused in creation-port test");
  },
} as GoalEvidenceSource;

function port(repository: GoalRepository) {
  return createGoalCreationPort({
    repository,
    session,
    executionId: "execution",
    agentInstanceId: "entry",
    seed: "Define the goal",
    evidence,
    defaultLimits: { max_net_tokens: 10_000 },
    now: () => 10,
  });
}

describe("createGoalCreationPort", () => {
  it("exposes idle runtime and in-flight handles before create starts", () => {
    const { lifecycle } = createCreationLifecycle(
      {
        repository: repositoryFixture().repository,
        session,
        executionId: "execution",
        agentInstanceId: "entry",
        seed: "Define the goal",
        evidence,
        defaultLimits: { max_net_tokens: 10_000 },
      },
      () => 10,
    );
    expect(lifecycle.runtime).toBeUndefined();
    expect(lifecycle.inFlight).toBeUndefined();
  });

  it("composes formulation, admission and runtime binding behind one idempotent port", async () => {
    const fixture = repositoryFixture();
    const creation = port(fixture.repository);

    const first = await creation.create(input);
    const second = await creation.create({ ...input, objective: "A different retry" });

    expect(second).toBe(first);
    expect(fixture.transactions()).toBe(1);
    expect(fixture.state()?.current).toMatchObject({
      session_id: "session",
      status: "active",
      runs: [{ execution_id: "execution", phase: "running" }],
    });
  });

  it("single-flights concurrent create requests", async () => {
    const release = Promise.withResolvers<void>();
    const fixture = repositoryFixture({ delay: release.promise });
    const creation = port(fixture.repository);
    const first = creation.create(input);
    const second = creation.create(input);

    release.resolve();
    expect(await first).toBe(await second);
    expect(fixture.transactions()).toBe(1);
  });
});
