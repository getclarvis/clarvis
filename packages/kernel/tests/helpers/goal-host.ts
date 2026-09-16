import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TraceEvent } from "@clarvis/capability";
import {
  admitGoalRun,
  advanceGoalRun,
  applyGoalControl,
  type GoalControl,
  type GoalCriterion,
} from "@clarvis/goal";
import { createGoalEvidenceSource } from "../../src/goals/evidence.ts";
import { createGoalRepository } from "../../src/goals/repository.ts";
import { createGoalRuntimePort, type GoalRuntimeChange } from "../../src/goals/runtime-port.ts";
import { createHostedSessionCoordinator } from "../../src/hosting/sessions.ts";
import { createSessionService, type HostSessionStore } from "../../src/sessions/session-service.ts";
import { recordingLogger } from "./logger.ts";

/** Real private session persistence and runtime authority, with explicit manual admission for tests. */
export async function goalHostFixture(
  options: {
    criteria?: GoalCriterion[];
    readTrace?: (executionId: string) => readonly TraceEvent[] | undefined;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "clarvis-goal-host-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const storeOptions = {
    dir: join(root, "state"),
    owner: "owner",
    projectId: "project",
    workspaceId: "workspace",
  };
  const base = createSessionService(storeOptions);
  let failure: "before" | "after" | undefined;
  let clock = 100;
  const store: HostSessionStore = {
    ...base,
    async saveHost(value) {
      if (failure === "before") throw new Error("private-storage-failure");
      await base.saveHost(value);
      if (failure === "after") throw new Error("private-storage-failure");
    },
  };
  const coordinator = createHostedSessionCoordinator({
    sessions: store,
    projectId: "project",
    workspaceId: "workspace",
    occupied: () => false,
    redact: (value) => value,
    now: () => clock++,
    async prepareExecution() {
      throw new Error("Test must admit its stage explicitly");
    },
  });
  await coordinator.sessions.save({
    id: "session",
    title: "Goal fixture",
    project_id: "project",
    workspace: "workspace",
    created_at: 1,
    updated_at: 1,
    turns: [],
    totals: { input: 0, cached: 0, output: 0 },
  });
  const repository = createGoalRepository(coordinator.sessions, coordinator);
  const changes: GoalRuntimeChange[] = [];
  const logger = recordingLogger();
  const control = (action: GoalControl["action"]) =>
    repository.transact("session", (state) => {
      const result = applyGoalControl(
        state,
        {
          expected_revision: state?.revision ?? 0,
          operation_id: `control-${clock++}`,
          action,
        },
        {
          session_id: "session",
          new_goal_id: `goal-${clock}`,
          now: clock++,
          physically_busy: state?.current?.runs.some((run) => run.phase !== "closed") ?? false,
        },
      );
      return { state: result.state, result };
    });
  await control({
    kind: "create",
    objective: "Verify the synthetic result",
    criteria: options.criteria ?? [],
    limits: { max_net_tokens: 100000, max_auto_continuations: 8, max_no_progress_checkpoints: 3 },
  });
  return {
    root,
    workspaceRoot,
    base,
    repository,
    coordinator,
    control,
    changes,
    logger,
    close: () => rm(root, { recursive: true, force: true }),
    fail(value?: "before" | "after") {
      failure = value;
    },
    reopen: () => createSessionService(storeOptions),
    admit: (executionId = "first") =>
      repository.transact("session", (state) => {
        const goal = state!.current!;
        const admitted = admitGoalRun(state!, {
          goal_id: goal.goal_id,
          expected_revision: state!.revision,
          control_revision: goal.control_revision,
          execution_id: executionId,
          admission_id: `admission-${executionId}`,
          automatic: false,
          now: clock++,
        });
        return {
          state: advanceGoalRun(admitted, {
            goal_id: goal.goal_id,
            execution_id: executionId,
            phase: "running",
            now: clock++,
          }),
          result: undefined,
        };
      }),
    async runtime(
      executionId = "first",
      overrides: {
        readArtifact?: (path: string) => Promise<Uint8Array>;
        signal?: AbortSignal;
        onChange?: (change: GoalRuntimeChange) => void;
      } = {},
    ) {
      const goal = (await repository.read("session"))!.current!;
      const evidence = createGoalEvidenceSource({
        executionId,
        workspaceRoot,
        readTrace: options.readTrace ?? (() => undefined),
        readArtifact: overrides.readArtifact,
      });
      const port = createGoalRuntimePort({
        repository,
        evidence,
        binding: {
          session_id: "session",
          agent_instance_id: "entry",
          execution_id: executionId,
          goal_id: goal.goal_id,
          objective_revision: goal.objective_revision,
        },
        signal: overrides.signal,
        logger,
        now: () => clock++,
        onChange:
          overrides.onChange ??
          ((change) => {
            changes.push(change);
          }),
      });
      return { port, evidence };
    },
  };
}
