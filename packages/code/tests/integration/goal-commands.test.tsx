import { afterEach, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { GoalControlRequest, GoalService, GoalView as GoalViewDto } from "@clarvis/protocol";
import { createCommands, type CommandUi } from "../../src/keys/commands.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { registerGoalCommands } from "../../src/features/goal/commands.ts";
import { createGoalController } from "../../src/features/goal/controller.ts";
import { createGoalDraft } from "../../src/features/goal/draft.ts";
import { GoalView } from "../../src/features/goal/view.tsx";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { openRender } from "../helpers/tracked-render.ts";
import { goalRun, goalView } from "../helpers/goals.ts";
import { hostedRef } from "../helpers/hosted-run.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(initial: GoalViewDto = goalView()) {
  let state = initial;
  const requests: GoalControlRequest[] = [];
  const opened: string[] = [];
  const notices: string[] = [];
  const keys = createFakeKeymap();
  let binding = { sessionId: "session-hosted", generation: 1 };
  const service: GoalService = {
    availability: async () => ({ available: true }),
    get: async () => structuredClone(state),
    subscribe: async () => () => {},
    receipt: async () => null,
    control: async (request) => {
      requests.push(request);
      state = { ...state, state: { ...state.state, revision: state.state.revision + 1 } };
      return {
        operation_id: request.operation_id,
        revision: state.state.revision,
        fingerprint: "fixture",
      };
    },
  };
  const goals = createGoalController({
    binding: () => binding,
    prepare: async () => binding,
    service: () => service,
  });
  cleanup.push(() => goals.dispose());
  const ui: CommandUi = {
    openView: (name) => {
      opened.push(name);
    },
    dismiss: () => {},
    commandFailed: (_name, error) => {
      notices.push(String(error));
    },
  };
  const interaction = { keymap: keys.keymap } as Interaction;
  const { host, controls } = createViewHost({ interaction, close: () => {}, dispatch: () => {} });
  cleanup.push(() => controls.dispose());
  return {
    requests,
    opened,
    notices,
    keys,
    goals,
    service,
    ui,
    host,
    controls,
    interaction,
    switchConversation() {
      binding = { sessionId: "another-session", generation: binding.generation + 1 };
      goals.reset();
    },
    notify: (message: string) => {
      notices.push(message);
    },
  };
}

test("goal slash controls never dispatch a prompt and preserve invalid syntax", async () => {
  const f = fixture({ state: { version: 1, revision: 0, archive: [], receipts: [] } });
  let commands!: ReturnType<typeof createCommands>;
  cleanup.push(
    createRoot((dispose) => {
      commands = createCommands(
        f.interaction,
        { clearSession: () => {}, status: () => {}, exportSession: () => {} },
        f.ui,
      );
      registerGoalCommands(commands.scope(), f);
      return () => {
        commands.dispose();
        dispose();
      };
    }),
  );
  expect(commands.route("goal.open", "pause nonsense")).toBe("block");
  expect(f.requests).toHaveLength(0);
  expect(commands.route("goal.open", "-- pause the deployment")).toBe(true);
  await settled();
  expect(f.requests[0]?.action).toEqual({ kind: "create", objective: "pause the deployment" });
  expect(f.opened).toEqual(["goal.open"]);
  commands.route("goal.open", "pause --running");
  await settled();
  expect(f.requests[1]?.action).toEqual({ kind: "pause", running: true });
});

test("an existing goal opens replacement review without sending a mutation", async () => {
  const f = fixture();
  cleanup.push(
    createRoot((dispose) => {
      const commands = createCommands(
        f.interaction,
        { clearSession: () => {}, status: () => {}, exportSession: () => {} },
        f.ui,
      );
      registerGoalCommands(commands.scope(), f);
      commands.route("goal.open", "A new objective");
      return () => {
        commands.dispose();
        dispose();
      };
    }),
  );
  await settled();
  expect(f.opened).toEqual(["goal.open"]);
  expect(f.requests).toHaveLength(0);
});

test("goal view separates pause from physical execution and identifies qualitative assessment", async () => {
  const f = fixture(
    goalView(
      { status: "paused" },
      hostedRef({ session_id: "session-hosted", execution_state: "running" }),
    ),
  );
  await f.goals.refresh();
  const rendered = await openRender(() => GoalView(f.host, f), { width: 110, height: 32 });
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("Goal: paused");
  expect(frame).toContain("Physical execution: running");
  expect(frame).toContain("Model assessment");
  expect(frame).toContain("Net tokens: 0 / 10000");
  f.keys.press("e");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).not.toContain("Edit goal");
  f.keys.press("x");
  await settled();
  expect(f.requests[0]?.action).toEqual({ kind: "pause", running: true });
});

test("goal form displays explicit whole-goal limits and submits its pinned revision", async () => {
  const f = fixture(goalView({ status: "paused" }));
  await f.goals.refresh();
  const draft = createGoalDraft(f.goals.view(), f.goals.binding());
  draft.objective = "Reviewed fixture objective";
  const rendered = await openRender(() => GoalView(f.host, { ...f, initialDraft: draft }), {
    width: 110,
    height: 32,
  });
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("Edit goal");
  expect(frame).toContain("Reviewed fixture objective");
  expect(frame).toContain("10000");

  f.keys.press("down");
  f.keys.press("return");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Total net tokens");
  f.keys.press("escape");
  f.keys.press("down");
  f.keys.press("return");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Automatic continuations");
  f.keys.press("escape");

  f.keys.press("ctrl+s");
  await settled();
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toMatchObject({
    expected_revision: 1,
    session_id: "session-hosted",
    action: {
      kind: "edit",
      objective: "Reviewed fixture objective",
      limits: { max_net_tokens: 10000 },
    },
  });
  f.controls.escape();
});

test.each([
  { failure: new Error("fixture rejected"), notice: "fixture rejected" },
  { failure: "unknown rejection", notice: "Goal change failed." },
])("goal form reports a rejected control as $notice", async ({ failure, notice }) => {
  const f = fixture(goalView({ status: "paused" }));
  f.service.control = async () => {
    throw failure;
  };
  await f.goals.refresh();
  const draft = createGoalDraft(f.goals.view(), f.goals.binding());
  const rendered = await openRender(() => GoalView(f.host, { ...f, initialDraft: draft }), {
    width: 110,
    height: 32,
  });
  await rendered.renderOnce();
  f.keys.press("ctrl+s");
  await settled();
  await settled();
  expect(f.notices).toContain(notice);
});

test("goal detail renders durable progress diagnostics and accepts a pending human criterion", async () => {
  const run = {
    ...goalRun("stage-1", "closed"),
    progress: { summary: "Implementation completed", evidence: [] },
    checkpoint: {
      summary: "Stage verified",
      next_step: "Collect operator approval",
      evidence: [],
      progress_accepted: true,
      reason: "Host observed activity",
    },
  };
  const view = goalView({
    status: "blocked",
    reason: "Awaiting review",
    criteria: [
      { id: "review", kind: "human", description: "Approve the verified result" },
      {
        id: "artifact",
        kind: "host",
        description: "Artifact digest matches",
        verification: { kind: "artifact_digest", path: "dist/result.json", digest: "b".repeat(64) },
      },
    ],
    limits: {
      max_net_tokens: 10000,
      max_auto_continuations: 8,
      max_no_progress_checkpoints: 3,
      deadline_at: Date.parse("2030-01-01T00:00:00Z"),
    },
    consumption: {
      input: 200,
      cached: undefined,
      output: 25,
      net_tokens: 225,
      usage_unknown: true,
      cache_estimated: true,
      overrun_tokens: 5,
    },
    auto_continuations: 2,
    no_progress_checkpoints: 1,
    runs: [run],
    candidate: {
      objective_revision: 1,
      execution_id: "stage-1",
      summary: "All automated checks passed",
      assessments: [],
    },
  });
  view.attention = "Review is required";
  const f = fixture(view);
  await f.goals.refresh();
  const rendered = await openRender(() => GoalView(f.host, f), { width: 110, height: 38 });
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("Goal: blocked (Awaiting review)");
  expect(frame).toContain("Review is required");
  expect(frame).toContain("usage incomplete");
  expect(frame).toContain("cache estimated");
  expect(frame).toContain("Completion candidate: All automated checks passed");
  expect(frame).toContain("Progress: Implementation completed");
  expect(frame).toContain("Checkpoint: Stage verified");

  f.keys.press("a");
  await rendered.renderOnce();
  f.keys.press("return");
  await rendered.renderOnce();
  expect(f.host.pendingConfirm()?.message).toBe("Accept this goal criterion?");
  f.keys.press("y");
  await settled();
  expect(f.requests[0]?.action).toEqual({
    kind: "accept",
    criterion_id: "review",
    objective_revision: 1,
  });
});

test.each([
  { acceptedRevision: 2, acceptedCriterion: "review", status: "accepted" },
  { acceptedRevision: 1, acceptedCriterion: "review", status: "pending" },
  { acceptedRevision: 2, acceptedCriterion: "another-criterion", status: "pending" },
  { acceptedRevision: undefined, acceptedCriterion: "review", status: "pending" },
])("human approval is $status only for its criterion and objective revision", async (scenario) => {
  const f = fixture(
    goalView({
      status: "paused",
      objective_revision: 2,
      criteria: [{ id: "review", kind: "human", description: "Review the checkpoint" }],
      human_acceptances:
        scenario.acceptedRevision === undefined
          ? []
          : [
              {
                criterion_id: scenario.acceptedCriterion,
                objective_revision: scenario.acceptedRevision,
                operation_id: "approval-operation",
                accepted_at: 1,
              },
            ],
    }),
  );
  await f.goals.refresh();
  const rendered = await openRender(() => GoalView(f.host, f), { width: 110, height: 32 });
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain(
    `Human approval (${scenario.status}): Review the checkpoint`,
  );
  f.keys.press("a");
  await rendered.renderOnce();
  if (scenario.status === "accepted") {
    expect(rendered.captureCharFrame()).toContain("Goal: paused");
  } else {
    expect(rendered.captureCharFrame()).not.toContain("Goal: paused");
  }
  expect(f.requests).toHaveLength(0);
});

test.each(["complete", "cancelled"] as const)(
  "human acceptance on a %s goal remains read-only",
  async (status) => {
    const f = fixture(
      goalView({
        status,
        criteria: [{ id: "review", kind: "human", description: "Review the checkpoint" }],
      }),
    );
    await f.goals.refresh();
    const rendered = await openRender(() => GoalView(f.host, f), { width: 110, height: 32 });
    await rendered.renderOnce();
    f.keys.press("a");
    await rendered.renderOnce();
    expect(rendered.captureCharFrame()).toContain(`Goal: ${status}`);
    expect(f.requests).toHaveLength(0);
  },
);

test.each(["complete", "cancelled"] as const)(
  "editing a %s goal requires confirmation of one atomic replacement",
  async (status) => {
    const f = fixture(goalView({ status }));
    await f.goals.refresh();
    const draft = createGoalDraft(f.goals.view(), f.goals.binding());
    const rendered = await openRender(() => GoalView(f.host, { ...f, initialDraft: draft }), {
      width: 110,
      height: 32,
    });
    await rendered.renderOnce();
    expect(rendered.captureCharFrame()).toContain("Review goal");
    f.keys.press("ctrl+s");
    await rendered.renderOnce();
    expect(f.host.pendingConfirm()?.message).toContain("Replace");
    expect(f.requests).toHaveLength(0);
    f.keys.press("n");
    await settled();
    expect(f.requests).toHaveLength(0);
    f.keys.press("ctrl+s");
    await settled();
    f.keys.press("y");
    await settled();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({
      expected_revision: 1,
      action: { kind: "replace", objective: "Verify the fixture" },
    });
  },
);

test("a reviewed form cannot mutate another conversation with the same revision", async () => {
  const f = fixture(goalView({ status: "paused" }));
  await f.goals.refresh();
  const draft = createGoalDraft(f.goals.view(), f.goals.binding());
  const rendered = await openRender(() => GoalView(f.host, { ...f, initialDraft: draft }), {
    width: 110,
    height: 32,
  });
  await rendered.renderOnce();
  f.switchConversation();
  await f.goals.refresh();
  f.keys.press("ctrl+s");
  await settled();
  expect(f.requests).toHaveLength(0);
  expect(f.notices.some((notice) => notice.includes("another conversation"))).toBe(true);
});

test("unknown physical work remains visible and prevents review without a hosted reference", async () => {
  const f = fixture(goalView({ status: "paused", runs: [goalRun("unknown-stage", "unknown")] }));
  await f.goals.refresh();
  const rendered = await openRender(() => GoalView(f.host, f), { width: 110, height: 32 });
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Physical execution: unknown");
  f.keys.press("e");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).not.toContain("Edit goal");
  expect(f.requests).toHaveLength(0);
});
