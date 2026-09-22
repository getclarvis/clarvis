import { applyGoalControl, admitGoalRun, prepareGoalSettlement } from "@clarvis/goal";
import { goalStateFromSession, goalStateToDto } from "../../src/goals/session-state.ts";
import { settleGoalSession } from "../../src/goals/settlement.ts";
import type { RunDetail, RunResult, Session } from "@clarvis/protocol";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileDurable } from "@clarvis/paths";
import { createSessionService } from "../../src/sessions/session-service.ts";
import { createHostedSessionCoordinator } from "../../src/hosting/sessions.ts";
import { createHostedRegistry, type HostedRegistry } from "../../src/hosting/registry.ts";
import { decodeHostedRegistryState } from "../../src/hosting/state.ts";
import { openHostedProjection } from "../../src/hosting/projection.ts";
import { createManagedRun } from "../../src/runs/managed-run.ts";

const [root, mode, phase] = process.argv.slice(2);
if (root === undefined || !["initial", "recover"].includes(mode ?? ""))
  throw new Error("invalid fixture arguments");
const index = join(root, "index.json");
const generation = randomUUID();
const starts = join(root, "starts.json");
const evidence = join(root, "steering.json");
const milestone = async (point: string) => {
  if (mode !== "initial" || phase !== point) return;
  process.stdin.resume();
  process.stdout.write(`${JSON.stringify({ milestone: point })}\n`);
  await new Promise<void>(() => {});
};
await mkdir(join(root, "sessions"), { recursive: true });
const base = createSessionService({
  dir: join(root, "sessions"),
  owner: "fixture",
  projectId: "project",
  workspaceId: "workspace",
});
const runtime: { registry?: HostedRegistry } = {};
const coordinator = createHostedSessionCoordinator({
  sessions: {
    ...base,
    async saveHost(value) {
      await base.saveHost(value);
      if (value.turns.some((turn) => turn.ended_at !== undefined))
        await milestone("session_committed");
    },
  },
  workspaceId: "workspace",
  projectId: "project",
  occupied: (id) => runtime.registry?.occupied(id) ?? false,
  redact: (text) => text,
  readRun: async () => JSON.parse(await readFile(evidence, "utf8")) as RunDetail,
  async prepareExecution(params) {
    if (mode !== "initial") throw new Error("restart must not prepare execution");
    return {
      config: { agent: "fixture" },
      detachable: true,
      ...(phase === "goal_prepared"
        ? {
            commitSessionIntent(session: Session) {
              const created = applyGoalControl(
                undefined,
                {
                  expected_revision: 0,
                  operation_id: "create",
                  action: {
                    kind: "create",
                    objective: "Retain partial work",
                    criteria: [],
                    limits: { max_net_tokens: 10000 },
                  },
                },
                { session_id: session.id, new_goal_id: "goal", now: 1, physically_busy: false },
              ).state;
              session.goal_state = goalStateToDto(
                admitGoalRun(created, {
                  goal_id: "goal",
                  execution_id: params.execution_id!,
                  admission_id: params.execution_id!,
                  automatic: false,
                  expected_revision: created.revision,
                  control_revision: created.current!.control_revision,
                  now: 2,
                }),
              );
            },
            async prepareSettlement(result: RunResult) {
              const session = (await base.get("session"))!;
              const preparation = {
                outcome: "failed" as const,
                disposition: "final" as const,
                usage: {
                  kind: "partial" as const,
                  input: 17,
                  output: 3,
                  cached: 2,
                  gaps: [{ cause: "no_usage" as const, calls: 1, call_ids: ["uncertain-call"] }],
                },
                activity_unavailable: true,
              };
              session.goal_state = goalStateToDto(
                prepareGoalSettlement(goalStateFromSession(session)!, {
                  goal_id: "goal",
                  execution_id: params.execution_id!,
                  preparation,
                  now: 3,
                }),
              );
              session.revision = (session.revision ?? 0) + 1;
              await base.saveHost(session);
              await milestone("goal_prepared");
              return (stored: Session) =>
                settleGoalSession(
                  stored,
                  result,
                  { ...preparation, completion_validated: false },
                  4,
                );
            },
          }
        : {}),
      async start() {
        await writeFileDurable(starts, "1");
        return createManagedRun({
          executionId: params.execution_id!,
          async execute() {
            if (phase === "steering_evidence") {
              await coordinator.acceptOperator(
                {
                  session_id: "session",
                  session_revision: 1,
                  kind: "conversation",
                  user_preview: "Retained steering",
                  params: {
                    execution_id: "steer_crash",
                    messages: [{ role: "user", content: "Continue" }],
                  },
                },
                params.execution_id!,
              );
              await writeFileDurable(
                evidence,
                JSON.stringify({
                  status: "running",
                  events: [
                    {
                      type: "steering_applied",
                      id: "steer_crash",
                      at: 1,
                      agent: "lead",
                      message: "Continue",
                    },
                  ],
                }),
              );
              await milestone("steering_evidence");
            }
            return {
              execution_id: params.execution_id!,
              status: phase === "goal_prepared" ? "failed" : "completed",
              ...(phase === "goal_prepared"
                ? {
                    error: {
                      code: "provider_error",
                      message: "Interrupted provider",
                      kind: "transient" as const,
                    },
                  }
                : {}),
              result: "fixture result",
              usage: {
                iterations: 1,
                elapsed_ms: 1,
                input_tokens: 17,
                output_tokens: 3,
                cached_tokens: 2,
              },
            };
          },
        });
      },
    };
  },
});
if (mode === "initial")
  await coordinator.sessions.save({
    id: "session",
    title: "Fixture",
    project_id: "project",
    workspace: "workspace",
    created_at: 1,
    updated_at: 1,
    turns: [],
    totals: { input: 0, output: 0, cached: 0 },
  });
const registry = createHostedRegistry({
  workspaceId: "workspace",
  hostGeneration: generation,
  owner: "fixture",
  ...(mode === "recover"
    ? { initialState: decodeHostedRegistryState(JSON.parse(await readFile(index, "utf8"))) }
    : {}),
  prepare: coordinator.prepare,
  recoverSettlement: coordinator.recoverSettlement,
  discoverDeliveries: coordinator.discoverDeliveries,
  deliverOperator: coordinator.deliverOperator,
  async settlementReconciled(run) {
    return (
      (await base.get(run.session_id))?.turns.some(
        (turn) => turn.execution_id === run.execution_id && turn.ended_at !== undefined,
      ) === true
    );
  },
  projection: (id) =>
    openHostedProjection(join(root, `${id}.jsonl`), {
      host_generation: generation,
      execution_id: id,
    }),
  async removeProjection() {},
  async commit(value) {
    await writeFileDurable(index, JSON.stringify(value));
    const row = value.runs[0];
    if (row?.run.execution_state === "closed") await milestone("terminal_committed");
    if (row?.settlement?.operation === "reconcile") await milestone("reconcile_checkpoint");
  },
});
runtime.registry = registry;
if (mode === "initial") {
  const peer = registry.connect("operator");
  const attachment = await peer.service.start({
    session_id: "session",
    session_revision: 1,
    kind: "conversation",
    user_preview: "Fixture",
    params: { execution_id: "execution", messages: [{ role: "user", content: "Fixture" }] },
  });
  await attachment.handle.closed;
  throw new Error("fixture did not reach the crash milestone");
} else {
  await registry.sync();
  const session = (await base.get("session"))!;
  const value = decodeHostedRegistryState(JSON.parse(await readFile(index, "utf8")));
  process.stdout.write(
    `${JSON.stringify({ occupied: registry.occupied("session"), starts: Number(await readFile(starts, "utf8")), turns: session.turns, intents: session.operator_intents, totals: session.totals, goal: session.goal_state?.current, run: value.runs[0]!.run })}\n`,
  );
  await registry.close();
}
