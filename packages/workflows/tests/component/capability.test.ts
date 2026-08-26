import { describe, expect, test } from "bun:test";
import { createCapabilityServices, type RunRequest } from "@clarvis/capability";
import {
  createWorkflowsCapability,
  WORKFLOW_GRANT,
  WORKFLOW_GRANT_DECLARATION,
  WORKFLOWS_CAPABILITY_NAME,
} from "../../src/capability.ts";
import { createWorkflowLedger } from "../../src/ledger.ts";
import { RUN_LEADER_TOOL_NAME } from "../../src/tool.ts";
import { RUN_ROUND_TOOL_NAME } from "../../src/run-round.ts";
import { RUN_WORK_ITEMS_TOOL_NAME } from "../../src/work-items.ts";
import type { LeaderSpec } from "../../src/types.ts";
import { makeCtx, recordingBc, runLeaderCall, scope, testRunCtx } from "../helpers/workflow.ts";

const RUN_CTX = testRunCtx().runCtx;

describe("workflows capability — activation requires a supervision registry", () => {
  test("forRun returns null without one: there is no synchronous run_leader to fall back to", async () => {
    const capability = createWorkflowsCapability(makeCtx());
    expect(
      await capability.forRun({
        services: createCapabilityServices(),
        entryGrants: [],
      } as never),
    ).toBeNull();
  });
});

describe("workflows capability", () => {
  test("is named 'workflows' and activates for a run", async () => {
    const capability = createWorkflowsCapability(makeCtx());
    expect(capability.name).toBe(WORKFLOWS_CAPABILITY_NAME);
    expect(capability.grants).toEqual([WORKFLOW_GRANT_DECLARATION]);
    expect(capability.reservedWireNames).toEqual([
      RUN_LEADER_TOOL_NAME,
      RUN_WORK_ITEMS_TOOL_NAME,
      RUN_ROUND_TOOL_NAME,
    ]);
    /* `spawn_run`, not `control`: a leader is a separate run with a profile the
       manager names and `plans` forced off, so a gate that trusts `control` to
       mean "bounded by the caller's own toolset" would be waved past by it. */
    expect(capability.toolEffects).toEqual({
      [RUN_LEADER_TOOL_NAME]: "spawn_run",
      [RUN_WORK_ITEMS_TOOL_NAME]: "spawn_run",
      [RUN_ROUND_TOOL_NAME]: "spawn_run",
    });
    expect(await capability.forRun(RUN_CTX)).not.toBeNull();
  });

  test("grants tools only to the manager while carrying the budget to descendants", async () => {
    const ctx = makeCtx();
    const run = await createWorkflowsCapability(ctx).forRun(RUN_CTX);
    expect(run).not.toBeNull();
    const manager = run!.forAgent(scope({ grants: [WORKFLOW_GRANT] }))!.attach(recordingBc().bc);
    const ungranted = run!.forAgent(scope({ grants: [] }))!.attach(recordingBc().bc);
    const child = run!.forAgent(scope({ entry: false }))!.attach(recordingBc().bc);
    expect(manager.tools?.map((tool) => tool.wireName)).toContain(RUN_LEADER_TOOL_NAME);
    expect(manager.outputBudget).toBe(ctx.ledger);
    expect(ungranted.tools).toBeUndefined();
    expect(child.tools).toBeUndefined();
    expect(ungranted.outputBudget).toBe(ctx.ledger);
    expect(child.outputBudget).toBe(ctx.ledger);
  });

  test("contributes every advertised spawn tool, each with its own handler", async () => {
    const run = await createWorkflowsCapability(makeCtx()).forRun(RUN_CTX);
    const contribution = run!.forAgent(scope())!.attach(recordingBc().bc);
    expect(contribution.tools?.map((t) => t.wireName)).toEqual([
      RUN_LEADER_TOOL_NAME,
      RUN_WORK_ITEMS_TOOL_NAME,
      RUN_ROUND_TOOL_NAME,
    ]);
    expect(contribution.handlers).toHaveLength(3);
    expect(contribution.advertised).toBe(true);
  });

  test("no two contributed tools share a wire name, which foldContributions would reject", async () => {
    const run = await createWorkflowsCapability(makeCtx()).forRun(RUN_CTX);
    const names = run!
      .forAgent(scope())!
      .attach(recordingBc().bc)
      .tools!.map((t) => t.wireName);
    expect(new Set(names).size).toBe(names.length);
  });

  test("each handler's matches() claims only its own tool, as the first-match dispatcher relies on", async () => {
    const run = await createWorkflowsCapability(makeCtx()).forRun(RUN_CTX);
    const [leaderHandler, workItemsHandler] = run!
      .forAgent(scope())!
      .attach(recordingBc().bc).handlers!;
    const workItemsCall = { name: RUN_WORK_ITEMS_TOOL_NAME, arguments: {} } as never;
    expect(leaderHandler!.matches(runLeaderCall({ prompt: "x" }))).toBe(true);
    expect(leaderHandler!.matches(workItemsCall)).toBe(false);
    expect(workItemsHandler!.matches(workItemsCall)).toBe(true);
    expect(workItemsHandler!.matches(runLeaderCall({ prompt: "x" }))).toBe(false);
    expect(leaderHandler!.matches({ name: "some_other_tool", arguments: {} } as never)).toBe(false);
  });

  test("refuses to spawn a leader once the tree budget is exhausted", async () => {
    const ctx = makeCtx({ ledger: createWorkflowLedger(0) });
    const run = await createWorkflowsCapability(ctx).forRun(RUN_CTX);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![0]!;
    const verdict = await handler.handle(runLeaderCall({ title: "Do it", prompt: "do it" }), 0);
    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") expect(verdict.text).toContain("budget exhausted");
  });

  test("rejects a run_leader call with no prompt", async () => {
    const run = await createWorkflowsCapability(makeCtx()).forRun(RUN_CTX);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![0]!;
    const verdict = await handler.handle(runLeaderCall({ title: "Do it" }), 0);
    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") expect(verdict.text).toContain("prompt");
  });

  test("rejects a run_leader call whose arguments are not an object", async () => {
    const run = await createWorkflowsCapability(makeCtx()).forRun(RUN_CTX);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![0]!;
    const verdict = await handler.handle(
      { name: RUN_LEADER_TOOL_NAME, arguments: null } as never,
      0,
    );
    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") expect(verdict.text).toContain("expected an object");
  });

  test("rejects a run_leader call with no title", async () => {
    const run = await createWorkflowsCapability(makeCtx()).forRun(RUN_CTX);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![0]!;
    const verdict = await handler.handle(runLeaderCall({ prompt: "do it" }), 0);
    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") expect(verdict.text).toContain("title");
  });

  test("refuses to spawn when the registry has no room for another live child, and releases the reservation", async () => {
    const ledger = createWorkflowLedger(10);
    const ctx = makeCtx({ ledger });
    const t = testRunCtx({ maxLiveChildren: 0 });
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![0]!;

    const verdict = await handler.handle(runLeaderCall({ title: "Do it", prompt: "do it" }), 0);
    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") expect(verdict.text).toContain("too many child agents");
    // The reservation taken before the registry refused must have been released,
    // not leaked against the tree budget.
    expect(ledger.remaining()).toBe(10);
  });

  test("parses profile and expect_schema from the call into the leader spec passed to assemble", async () => {
    let seenSpec: LeaderSpec | undefined;
    const ctx = makeCtx({
      assemble: (spec) => {
        seenSpec = spec;
        return {} as RunRequest;
      },
    });
    const t = testRunCtx();
    const run = await createWorkflowsCapability(ctx).forRun(t.runCtx);
    const handler = run!.forAgent(scope())!.attach(recordingBc().bc).handlers![0]!;

    await handler.handle(
      runLeaderCall({
        title: "Do it",
        prompt: "do it",
        profile: "researcher",
        expect_schema: { type: "object" },
      }),
      0,
    );
    await t.settle();

    expect(seenSpec?.profile).toBe("researcher");
    expect(seenSpec?.expectSchema).toEqual({ type: "object" });
  });
});
