import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuiltinTraceEvent } from "@clarvis/capability";
import {
  advanceGoalRun,
  GoalError,
  settleGoalRun,
  type GoalCriterion,
  type GoalOperationOutcome,
  type GoalRepository,
} from "@clarvis/goal";
import { createJsonTraceStore, mapEntry } from "@clarvis/trace";
import { createGoalEvidenceSource, goalEvidenceDigest } from "../../src/goals/evidence.ts";
import { createGoalRuntimePort } from "../../src/goals/runtime-port.ts";
import { goalHostFixture } from "../helpers/goal-host.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(options: Parameters<typeof goalHostFixture>[0] = {}) {
  const f = await goalHostFixture(options);
  cleanup.push(f.close);
  await f.admit();
  return f;
}

/** Unwrap an accepted model operation; a refusal here is a test failure, not an expected shape. */
function accepted<T>(outcome: GoalOperationOutcome<T>): T {
  if (outcome.kind !== "ok") throw new Error(`goal operation was refused: ${outcome.reason}`);
  return outcome.value;
}
type ToolEvent = Extract<BuiltinTraceEvent, { type: "tool_call" }>;
type DelegationEvent = Extract<BuiltinTraceEvent, { type: "delegation_completed" }>;
const tool = (changes: Partial<ToolEvent> = {}): ToolEvent => ({
  type: "tool_call",
  agent: "lead",
  call_id: "check",
  iteration_ref: 0,
  started_at: 1,
  ended_at: 2,
  mcp_name: "shell",
  tool_name: "",
  arguments: { command: "bun run verify" },
  result: JSON.stringify({ exit_code: 0 }),
  error: null,
  ...changes,
});
const delegation = (changes: Partial<DelegationEvent> = {}): DelegationEvent => ({
  type: "delegation_completed",
  delegation_id: "helper-run",
  completed_at: 2,
  status: "completed",
  result: "Implemented the bounded change and returned the inspected file summary.",
  ...changes,
});
const toolCriterion: GoalCriterion = {
  id: "check",
  kind: "host",
  description: "The declared check must succeed",
  verification: {
    kind: "tool_success",
    tool_name: "shell",
    arguments_digest: goalEvidenceDigest({ command: "bun run verify" }),
  },
};
const bytes = Buffer.from("synthetic result\n");
const digest = createHash("sha256").update(bytes).digest("hex");
const artifactCriterion: GoalCriterion = {
  id: "artifact",
  kind: "host",
  description: "Exact result bytes",
  verification: { kind: "artifact_digest", path: "result.txt", digest },
};
const candidate = (
  id = "objective",
  kind: "qualitative" | "host" | "human" = "qualitative",
  refs: string[] = [],
) => ({
  summary: "The synthetic result was checked",
  assessments: [
    { criterion_id: id, kind, justification: "Observed the requested result", evidence_ids: refs },
  ],
});
async function settle(f: Awaited<ReturnType<typeof fixture>>) {
  await f.repository.transact("session", (state) => ({
    state: settleGoalRun(state!, {
      goal_id: state!.current!.goal_id,
      execution_id: "first",
      physical_closed: true,
      outcome: "completed",
      disposition: "checkpoint",
      completion_validated: false,
      usage: { kind: "complete", input: 100, cached: 80, output: 5 },
      now: 500,
    }),
    result: undefined,
  }));
}

describe("durable host goal runtime port", () => {
  it("acknowledges a durable impediment when its change notification closes the run", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const { port } = await f.runtime("first", {
      signal: controller.signal,
      onChange: () => controller.abort(),
    });

    await expect(port.blocked("Synthetic external boundary")).resolves.toBeUndefined();
    expect((await f.repository.read("session"))!.current!.runs.at(-1)!.impediment).toMatchObject({
      reason: "Synthetic external boundary",
    });
  });

  it("recovers a temporarily unavailable catalog on the next read without masking revoked authority", async () => {
    const f = await fixture();
    const { port, evidence } = await f.runtime();
    evidence.observe(tool());
    const snapshot = evidence.snapshot.bind(evidence);
    evidence.snapshot = async () => {
      throw new GoalError("conflict", "Synthetic concurrent observation");
    };
    expect(await port.read()).toMatchObject({ evidence: [], evidence_unavailable: "conflict" });
    evidence.snapshot = snapshot;
    const recovered = await port.read();
    expect(recovered.evidence).toHaveLength(1);
    expect(recovered.evidence_unavailable).toBeUndefined();
    evidence.snapshot = async () => {
      await f.control({ kind: "cancel" });
      throw new GoalError("resource_exhausted", "Synthetic unavailable catalog");
    };
    await expect(port.read()).rejects.toMatchObject({ code: "conflict" });
  });

  it("does not classify an unexpected evidence exception as recoverable", async () => {
    const f = await fixture();
    const { port, evidence } = await f.runtime();
    evidence.snapshot = async () => {
      throw new Error("Unexpected private failure");
    };
    await expect(port.read()).rejects.toMatchObject({ code: "internal" });
  });

  it("refuses completion without a candidate and accepts a valid current candidate", async () => {
    const f = await fixture();
    const { port } = await f.runtime();
    expect(await port.validateCompletion()).toMatchObject({
      valid: false,
      reasons: ["The current stage has no completion candidate"],
    });
    await port.candidate(candidate());
    expect(await port.validateCompletion()).toMatchObject({ valid: true, reasons: [] });
  });

  it("interprets the real trace mapper's flat tool names without treating goal controls as evidence", async () => {
    const f = await fixture({ criteria: [toolCriterion] });
    const { port, evidence } = await f.runtime();
    let index = 0;
    const mapped = (name: string, result: string) =>
      mapEntry(
        {
          at: ++index,
          kind: "tool_call",
          detail: {
            name,
            agent: "lead",
            iteration_ref: index,
            call_id: `mapped-${index}`,
            started_at: index,
            ended_at: index,
            arguments: { command: "bun run verify" },
            result,
            error: null,
          },
        },
        100,
      )!;
    for (const name of ["get_goal", "update_goal", "agent_status", "shell_session"])
      evidence.observe(mapped(name, "Control acknowledged"));
    expect((await port.read()).evidence).toEqual([]);
    for (const result of [
      JSON.stringify({ exit_code: 1 }),
      JSON.stringify({ exit_code: 0, timed_out: true }),
      "malformed",
    ])
      evidence.observe(mapped("shell", result));
    expect((await port.read()).evidence).toEqual([]);
    evidence.observe(mapped("remote.shell", "Remote tool completed"));
    const remote = (await port.read()).evidence[0]!;
    expect(remote.description).toStartWith("remote.shell: ");
    expect(accepted(await port.candidate(candidate("check", "host", [remote.id])))).toMatchObject({
      valid: false,
    });
    evidence.observe(mapped("shell", JSON.stringify({ exit_code: 0 })));
    const native = (await port.read()).evidence.find((ref) =>
      ref.description.startsWith("shell: "),
    )!;
    expect(native).toBeDefined();
    expect(accepted(await port.candidate(candidate("check", "host", [native.id])))).toMatchObject({
      valid: true,
    });
    evidence.observe(mapped("shell", JSON.stringify({ exit_code: 1 })));
    expect(await port.validateCompletion()).toMatchObject({ valid: false });
  });

  it("persists annotations and candidates without completing, then retains them on reopen", async () => {
    const f = await fixture();
    const { port } = await f.runtime();
    await port.progress({ summary: "Prepared the result", evidence_ids: [] });
    expect(
      accepted(
        await port.checkpoint({
          summary: "Stage ended",
          next_step: "Check result",
          evidence_ids: [],
        }),
      ),
    ).toMatchObject({ progress_accepted: false });
    expect(accepted(await port.candidate(candidate()))).toMatchObject({
      valid: true,
      qualitative_criteria: ["objective"],
    });
    const state = (await f.repository.read("session"))!;
    expect((await f.reopen().get("session"))!.goal_state).toEqual(state);
    expect(state.current).toMatchObject({ status: "active", consumption: { net_tokens: 0 } });
    expect(state.current!.runs[0]!.progress?.summary).toBe("Prepared the result");
    expect(f.changes.map((change) => change.kind)).toEqual(["progress", "checkpoint", "candidate"]);
    expect(await port.validateCompletion()).toMatchObject({ valid: true });
  });

  it("checks the declared tool and arguments and rejects a later contradictory failure", async () => {
    const f = await fixture({ criteria: [toolCriterion] });
    const { port, evidence } = await f.runtime();
    evidence.observe(tool({ arguments: { command: "unrelated" }, call_id: "unrelated" }));
    const unrelated = (await port.read()).evidence[0]!;
    expect(
      accepted(await port.candidate(candidate("check", "host", [unrelated.id]))),
    ).toMatchObject({
      valid: false,
    });
    evidence.observe(tool());
    const ref = (await port.read()).evidence.find(
      (ref) => ref.description === "shell: bun run verify",
    )!;
    expect(accepted(await port.candidate(candidate("check", "host", [ref.id])))).toMatchObject({
      valid: true,
    });
    evidence.observe(
      tool({ call_id: "later", result: JSON.stringify({ exit_code: 1 }), error: null }),
    );
    expect(await port.validateCompletion()).toMatchObject({ valid: false });
    /** An obsolete identifier is corrigible input, not an unavailable control. */
    expect(
      await port.progress({ summary: "Obsolete success", evidence_ids: [ref.id] }),
    ).toMatchObject({ kind: "invalid" });
    expect((await port.read()).evidence.map((item) => item.id)).not.toContain(ref.id);
  });

  it.each([
    JSON.stringify({ exit_code: 1 }),
    JSON.stringify({ exit_code: 0, timed_out: true }),
    JSON.stringify({ exit_code: 0, signal: "SIGTERM" }),
    "malformed",
    "null",
    "{}",
  ])("does not treat a successful transport as command success: %s", async (result) => {
    const f = await fixture({ criteria: [toolCriterion] });
    const { port, evidence } = await f.runtime();
    evidence.observe(tool({ result }));
    expect((await port.read()).evidence).toEqual([]);
    expect(accepted(await port.candidate(candidate("check", "host")))).toMatchObject({
      valid: false,
    });
  });

  it("rejects fabricated references and stamps valid scope without leaking catalog metadata into state", async () => {
    const f = await fixture();
    const { port, evidence } = await f.runtime();
    evidence.observe(tool());
    const snapshot = await port.read();
    const ref = snapshot.evidence[0]!;
    expect(
      await port.progress({ summary: "Invented", evidence_ids: ["foreign-run-proof"] }),
    ).toMatchObject({ kind: "invalid" });
    expect(
      await port.progress({ summary: "Repeated", evidence_ids: [ref.id, ref.id] }),
    ).toMatchObject({ kind: "invalid" });
    await port.progress({ summary: "Observed", evidence_ids: [ref.id] });
    const stored = (await f.repository.read("session"))!.current!.runs[0]!.progress!.evidence[0]!;
    expect(stored).toMatchObject({
      goal_id: port.binding.goal_id,
      execution_id: "first",
      objective_revision: 1,
    });
    expect(stored).not.toHaveProperty("description");
    const view = await evidence.snapshot(snapshot.goal);
    view.catalog[0]!.digest = "forged";
    expect(view.resolve([ref.id])[0]!.digest).toBe(ref.digest);
    expect(
      await view.verify(
        { ...stored, execution_id: "foreign" },
        { id: "q", kind: "qualitative", description: "q" },
      ),
    ).toMatchObject({ valid: false });
  });

  it("verifies actual artifact bytes and invalidates qualitative references after mutation too", async () => {
    const f = await fixture({ criteria: [artifactCriterion] });
    await writeFile(join(f.workspaceRoot, "result.txt"), bytes);
    const { port, evidence } = await f.runtime();
    const { goal, evidence: catalog } = await port.read();
    const ref = catalog[0]!;
    expect(ref.digest).toBe(digest);
    expect(accepted(await port.candidate(candidate("artifact", "host", [ref.id])))).toMatchObject({
      valid: true,
    });
    const snapshot = await evidence.snapshot(goal);
    /** A reference the stage cites as an artifact still counts as that stage's progress. */
    const checkpoint = await port.checkpoint({
      summary: "Artifact verified",
      next_step: "Report the result",
      evidence_ids: [ref.id],
    });
    expect(accepted(checkpoint).progress_accepted).toBe(true);
    await writeFile(join(f.workspaceRoot, "result.txt"), "changed");
    expect(
      await snapshot.verify(ref, { id: "q", kind: "qualitative", description: "q" }),
    ).toMatchObject({ valid: false });
    expect(await port.validateCompletion()).toMatchObject({ valid: false });
    expect(await port.candidate(candidate("artifact", "host", [ref.id]))).toMatchObject({
      kind: "invalid",
    });
    expect((await port.read()).evidence[0]!.id).not.toBe(ref.id);
    /** An artifact that vanished cannot support completion at all, and it stays corrigible. */
    await rm(join(f.workspaceRoot, "result.txt"));
    expect(
      await snapshot.verify(ref, { id: "q", kind: "qualitative", description: "q" }),
    ).toMatchObject({ valid: false, reason: "Current artifact digest is unavailable" });
    expect((await port.read()).evidence).toEqual([]);
  });

  it("refuses outside workspace artifacts, including directory links, and unavailable bytes", async () => {
    const outside = {
      ...artifactCriterion,
      verification: { kind: "artifact_digest" as const, path: "escape/result.txt", digest },
    };
    const f = await fixture({ criteria: [outside] });
    const external = join(f.root, "external");
    await mkdir(external);
    await writeFile(join(external, "result.txt"), bytes);
    await symlink(external, join(f.workspaceRoot, "escape"), "junction");
    const { port } = await f.runtime();
    expect((await port.read()).evidence).toEqual([]);
    expect(accepted(await port.candidate(candidate("artifact", "host")))).toMatchObject({
      valid: false,
    });
    const missing = await f.runtime("first", {
      readArtifact: async () => {
        throw new Error("private-file-path");
      },
    });
    expect((await missing.port.read()).evidence).toEqual([]);
    const oversized = await f.runtime("first", {
      readArtifact: async () => new Uint8Array(16 * 1024 * 1024 + 1),
    });
    expect((await oversized.port.read()).evidence).toEqual([]);
  });

  it("requires recorded human acceptance and leaves qualitative claims labeled", async () => {
    const f = await fixture({
      criteria: [{ id: "review", kind: "human", description: "User review" }],
    });
    const { port } = await f.runtime();
    expect(accepted(await port.candidate(candidate("review", "human")))).toMatchObject({
      valid: false,
    });
    await f.control({ kind: "accept", criterion_id: "review", objective_revision: 1 });
    expect(await port.validateCompletion()).toMatchObject({
      valid: true,
      qualitative_criteria: [],
    });
    expect((await f.repository.read("session"))!.current!.status).toBe("active");
  });

  it("reports a state conflict, not a candidate deficiency, when the goal moves during validation", async () => {
    const f = await fixture({
      criteria: [{ id: "review", kind: "human", description: "User review" }],
    });
    const goal = (await f.repository.read("session"))!.current!;
    const evidence = createGoalEvidenceSource({
      executionId: "first",
      workspaceRoot: f.workspaceRoot,
      readTrace: () => undefined,
    });
    /**
     * One validation reads the bound state twice and then re-reads it to rule on
     * what the check actually saw. Moving the goal immediately before that third
     * read is the race a slow evidence check leaves open, and it needs no timing:
     * reads are only counted once armed, which happens after the candidate is durable.
     */
    let reads = 0;
    let armed = false;
    let moved = false;
    const repository: GoalRepository = {
      read: async (sessionId) => {
        if (armed) {
          reads += 1;
          if (reads === 3 && !moved) {
            moved = true;
            // A non-revoking human acceptance is the real shape of this race, and it
            // is what makes the candidate completable once the state is quiet again.
            await f.control({ kind: "accept", criterion_id: "review", objective_revision: 1 });
          }
        }
        return f.repository.read(sessionId);
      },
      transact: (sessionId, mutation) => f.repository.transact(sessionId, mutation),
    };
    const port = createGoalRuntimePort({
      repository,
      evidence,
      binding: {
        session_id: "session",
        agent_instance_id: "entry",
        execution_id: "first",
        goal_id: goal.goal_id,
        objective_revision: goal.objective_revision,
      },
    });
    expect(accepted(await port.candidate(candidate("review", "human")))).toMatchObject({
      valid: false,
    });

    armed = true;
    // The verdict says nothing about the candidate, so it must not be reported as
    // one, and the next quiet validation settles the same attempt.
    expect(await port.validateCompletion()).toMatchObject({
      valid: false,
      reasons: ["Goal or evidence changed during completion validation"],
      cause: "state_conflict",
    });
    expect(moved).toBe(true);
    expect(await port.validateCompletion()).toMatchObject({ valid: true });
    expect((await f.repository.read("session"))!.current!.status).toBe("active");
  });

  it.each(["pause", "cancel"] as const)(
    "revalidates %s after a slow evidence read without holding the session lock",
    async (kind) => {
      const f = await fixture({ criteria: [artifactCriterion] });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const { port } = await f.runtime("first", {
        readArtifact: async () => {
          entered.resolve();
          await release.promise;
          return bytes;
        },
      });
      const reading = port.read();
      const outcome = reading.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await entered.promise;
      try {
        await f.control(kind === "pause" ? { kind, running: false } : { kind });
      } finally {
        release.resolve();
      }
      const result = await outcome;
      if (kind === "pause") {
        expect(result).toMatchObject({ value: { goal: { status: "paused" } } });
        await port.progress({ summary: "Finishing current work", evidence_ids: [] });
      } else expect(result).toMatchObject({ error: { code: "conflict" } });
      await port.blocked("Delayed model blocker");
      expect((await f.repository.read("session"))!.current!.status).toBe(
        kind === "pause" ? "paused" : "cancelled",
      );
    },
  );

  it("rejects observation changes during slow evidence preparation before publishing progress", async () => {
    const f = await fixture({ criteria: [artifactCriterion] });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { port, evidence } = await f.runtime("first", {
      readArtifact: async () => {
        entered.resolve();
        await release.promise;
        return bytes;
      },
    });
    const pending = port.progress({ summary: "Race", evidence_ids: [] });
    const outcome = pending.then(
      () => ({ success: true }),
      (error: unknown) => ({ error }),
    );
    await entered.promise;
    evidence.observe(tool());
    release.resolve();
    expect(await outcome).toMatchObject({ error: { code: "conflict" } });
    expect((await f.repository.read("session"))!.current!.runs[0]!.progress).toBeUndefined();
    expect(f.changes).toEqual([]);
  });

  it.each(["before", "after"] as const)(
    "reports a safe storage failure %s durable publication without claiming an event",
    async (when) => {
      const f = await fixture();
      const { port } = await f.runtime();
      f.fail(when);
      await expect(
        port.progress({ summary: "Recorded progress", evidence_ids: [] }),
      ).rejects.toMatchObject({ code: "internal", message: "Goal state operation failed" });
      expect(f.changes).toEqual([]);
      expect(JSON.stringify(f.logger.records)).not.toContain("private-storage-failure");
      const progress = (await f.reopen().get("session"))!.goal_state!.current!.runs[0]!.progress;
      expect(progress?.summary).toBe(when === "after" ? "Recorded progress" : undefined);
    },
  );

  it("does not roll back a durable change when notification fails", async () => {
    const f = await fixture();
    const { port } = await f.runtime("first", {
      onChange: () => {
        throw new Error("private-observer");
      },
    });
    await port.blocked("Need user authority");
    const declared = (await f.reopen().get("session"))!.goal_state!.current!;
    expect(declared.runs[0]!.impediment).toMatchObject({ reason: "Need user authority" });
    expect(declared.status).toBe("active");
    expect(f.logger.events("goal.notification.failed")).toHaveLength(1);
    expect(JSON.stringify(f.logger.records)).not.toContain("private-observer");
    await port.blocked("Repeated blocker");
    expect(f.logger.events("goal.notification.failed")).toHaveLength(1);
  });

  it("fences aborted, foreign and physically closed stages while allowing settling validation", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const { port, evidence } = await f.runtime("first", { signal: controller.signal });
    const foreign = createGoalRuntimePort({
      repository: f.repository,
      evidence,
      binding: { ...port.binding, goal_id: "foreign" },
    });
    await expect(foreign.read()).rejects.toMatchObject({ code: "conflict" });
    await port.candidate(candidate());
    await f.repository.transact("session", (state) => ({
      state: advanceGoalRun(state!, {
        goal_id: port.binding.goal_id,
        execution_id: "first",
        phase: "settling",
        now: 400,
      }),
      result: undefined,
    }));
    expect(await port.validateCompletion()).toMatchObject({ valid: true });
    await expect(port.progress({ summary: "Late", evidence_ids: [] })).rejects.toMatchObject({
      code: "conflict",
    });
    await settle(f);
    await expect(port.read()).rejects.toMatchObject({ code: "conflict" });
    controller.abort();
    await expect(port.blocked("Cancelled")).rejects.toMatchObject({ code: "cancelled" });
  });

  it("reuses prior trace evidence but rejects repeated checks as new progress across stages", async () => {
    const events = [tool()];
    const f = await fixture({
      criteria: [toolCriterion],
      readTrace: (id) => (id === "first" ? events : undefined),
    });
    const first = await f.runtime();
    first.evidence.observe(events[0]!);
    const ref = (await first.port.read()).evidence[0]!;
    const checkpoint = await first.port.checkpoint({
      summary: "Checked",
      next_step: "Continue",
      evidence_ids: [ref.id],
    });
    expect(accepted(checkpoint).progress_accepted).toBe(true);
    await settle(f);
    await f.admit("second");
    const second = await f.runtime("second");
    expect((await second.port.read()).evidence[0]!.id).toBe(ref.id);
    second.evidence.observe(
      tool({
        call_id: "new-check",
        result: JSON.stringify({ exit_code: 0, stdout: "different wording" }),
      }),
    );
    const newRef = (await second.port.read()).evidence[0]!;
    expect(newRef.id).not.toBe(ref.id);
    expect(
      accepted(
        await second.port.checkpoint({
          summary: "Checked again",
          next_step: "Continue again",
          evidence_ids: [newRef.id],
        }),
      ),
    ).toMatchObject({ progress_accepted: false });
    events.push(tool({ result: JSON.stringify({ exit_code: 1 }) }));
    expect(await second.port.read()).toMatchObject({ evidence: [newRef] });
  });

  it("preserves control while ambiguous evidence still refuses completion", async () => {
    const f = await fixture();
    const { port, evidence } = await f.runtime();
    evidence.observe(tool({ mcp_name: "get_goal" }));
    expect(evidence.generation).toBe(0);
    evidence.observe(tool());
    evidence.observe(tool());
    expect(evidence.generation).toBe(1);
    const snapshot = await evidence.snapshot((await port.read()).goal);
    const ref = snapshot.resolve([snapshot.catalog[0]!.id])[0]!;
    evidence.observe(tool({ call_id: "other" }));
    expect(await snapshot.verify(ref, toolCriterion)).toMatchObject({ valid: false });
    evidence.observe(tool({ result: "different" }));
    expect(await port.read()).toMatchObject({ evidence: [] });
    expect(await port.validateCompletion()).toMatchObject({ valid: false });
    evidence.observe(tool({ call_id: "independent", arguments: { command: "independent" } }));
    const recovered = await port.read();
    expect(recovered.evidence).toHaveLength(1);
    expect(recovered.evidence_unavailable).toBeUndefined();
    const recoveredEvidence = await evidence.snapshot(recovered.goal);
    expect(() => recoveredEvidence.stageActivity()).toThrow("unavailable observation");
  });

  it("isolates oversized arguments and delegation results from independent evidence", async () => {
    const f = await fixture({ criteria: [toolCriterion] });
    const { port, evidence } = await f.runtime();
    evidence.observe(
      tool({ call_id: "oversized-arguments", arguments: { command: "x".repeat(1024 * 1024 + 1) } }),
    );
    evidence.observe(delegation({ result: "x".repeat(1024 * 1024 + 1) }));
    evidence.observe(
      tool({ call_id: "oversized-encoded-result", result: "\u0000".repeat(200_000) }),
    );
    evidence.observe(tool({ call_id: "oversized-diff", diff: "x".repeat(1024 * 1024 + 1) }));
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 34; depth++) nested = { child: nested };
    evidence.observe(tool({ call_id: "nested-arguments", arguments: nested }));
    evidence.observe(tool());
    const read = await port.read();
    expect(read.evidence_unavailable).toBeUndefined();
    expect(read.evidence).toHaveLength(1);
    const snapshot = await evidence.snapshot(read.goal);
    expect(snapshot.delegations).toEqual([]);
    expect(() => snapshot.stageActivity()).toThrow("unavailable observation");
    expect(
      await snapshot.verify(snapshot.resolve([read.evidence[0]!.id])[0]!, toolCriterion),
    ).toMatchObject({ valid: true });
    expect(
      accepted(await port.candidate(candidate("check", "host", [read.evidence[0]!.id]))),
    ).toBeDefined();
    expect(await port.validateCompletion()).toMatchObject({ valid: true });
  });

  it("retains a pinned candidate across thousands of child observations and source reopen", async () => {
    const f = await fixture({
      criteria: [toolCriterion],
      readTrace: (id) => store.readEvents?.("fixture", id),
    });
    const store: ReturnType<typeof createJsonTraceStore> = createJsonTraceStore({
      dir: join(f.workspaceRoot, "traces"),
    });
    const journal = store.openJournal({
      header: {
        id: "first",
        owner_key_name: "fixture",
        started_at: 1,
        visibility: "public",
        request: {
          messages: [],
          entry: "solo",
          profiles: [{ name: "solo", model: "test/model", tools: [], iteration_limit: 512 }],
          servers: [],
          providers: [],
          budget: { on_exceed: "stop", total_token_limit: 10000 },
        },
      },
    });
    cleanup.push(async () => journal.close());
    const { port, evidence } = await f.runtime();
    const observe = (event: ToolEvent) => {
      journal.append(event);
      evidence.observe(event);
    };
    observe(tool());
    const original = (await port.read()).evidence[0]!;
    expect(accepted(await port.candidate(candidate("check", "host", [original.id]))).valid).toBe(
      true,
    );
    for (let i = 0; i < 2048; i++)
      observe(
        tool({
          call_id: `call-${i % 512}`,
          subagent_instance_id: `child-${Math.floor(i / 512)}`,
          mcp_name: "grep",
          arguments: { pattern: `synthetic-${i}` },
          result: "synthetic match",
        }),
      );
    expect((await port.read()).evidence_unavailable).toBeUndefined();
    expect((await port.read()).evidence.length).toBeLessThanOrEqual(32);
    expect((await port.validateCompletion()).valid).toBe(true);
    const reopened = await f.runtime();
    expect((await reopened.port.validateCompletion()).valid).toBe(true);
    const failure = tool({ call_id: "later-failure", result: JSON.stringify({ exit_code: 1 }) });
    journal.append(failure);
    reopened.evidence.observe(failure);
    const duplicate = tool();
    journal.append(duplicate);
    reopened.evidence.observe(duplicate);
    expect((await reopened.port.validateCompletion()).valid).toBe(false);
  });

  it("keeps a conflicting candidate invalid through window rotation and source reopen", async () => {
    const events: ToolEvent[] = [];
    const f = await fixture({ criteria: [toolCriterion], readTrace: () => events });
    const { port, evidence } = await f.runtime();
    const observe = (event: ToolEvent) => {
      events.push(event);
      evidence.observe(event);
    };
    observe(tool());
    const original = (await port.read()).evidence[0]!;
    expect(accepted(await port.candidate(candidate("check", "host", [original.id]))).valid).toBe(
      true,
    );
    observe(tool({ result: JSON.stringify({ exit_code: 1 }) }));
    expect((await port.validateCompletion()).valid).toBe(false);
    for (let i = 0; i < 513; i++)
      observe(tool({ call_id: `independent-${i}`, arguments: { command: `independent-${i}` } }));
    for (const runtime of [{ port, evidence }, await f.runtime()]) {
      const snapshot = await runtime.port.read();
      expect(snapshot.evidence_unavailable).toBeUndefined();
      expect(snapshot.evidence.length).toBeGreaterThan(0);
      expect(snapshot.evidence.some((ref) => ref.id === original.id)).toBe(false);
      expect((await runtime.port.validateCompletion()).valid).toBe(false);
      const source = await runtime.evidence.snapshot(snapshot.goal);
      expect(() => source.stageActivity()).toThrow("unavailable observation");
    }
  });

  it("waits for the existing journal after the live evidence window rotates", async () => {
    const events: ToolEvent[] = [];
    let available = false;
    const f = await fixture({
      readTrace: (id) => (available && id === "first" ? events : undefined),
    });
    const { port, evidence } = await f.runtime();
    for (let i = 0; i < 513; i++) {
      const event = tool({ call_id: `event-${i}` });
      events.push(event);
      evidence.observe(event);
    }
    expect(await port.read()).toMatchObject({
      evidence: [],
      evidence_unavailable: "resource_exhausted",
    });
    available = true;
    expect((await port.read()).evidence_unavailable).toBeUndefined();
    expect((await port.read()).evidence).toHaveLength(1);
  });

  it("does not let replayed duplicate trace events revive an older success", async () => {
    const success = tool();
    const failure = tool({ call_id: "failed", result: JSON.stringify({ exit_code: 1 }) });
    const f = await fixture({
      criteria: [toolCriterion],
      readTrace: () => [success, failure, success],
    });
    const first = await f.runtime();
    await first.port.checkpoint({ summary: "Stage ended", next_step: "Recheck", evidence_ids: [] });
    await settle(f);
    await f.admit("second");
    const second = await f.runtime("second");
    expect((await second.port.read()).evidence).toEqual([]);
    expect(accepted(await second.port.candidate(candidate("check", "host")))).toMatchObject({
      valid: false,
    });
  });

  it("describes a catalog option by its operation instead of an opaque call id", async () => {
    const f = await fixture({ criteria: [toolCriterion] });
    const { port, evidence } = await f.runtime();
    evidence.observe(tool({ call_id: "model-chosen-id" }));
    const option = (await port.read()).evidence[0]!;
    expect(option.description).toBe("shell: bun run verify");
    evidence.observe(tool({ call_id: "unlabelled", arguments: { unrelated: true } }));
    expect((await port.read()).evidence.at(-1)!.description).toBe("shell");
    /** The label is presentation: identity, scope and digest remain the authority. */
    expect(option.id).toStartWith("tool-");
    expect(option.execution_id).toBe("first");
    expect(option.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("reports only the bound stage's own successful receipts, never what it merely cited", async () => {
    const f = await fixture({ criteria: [toolCriterion] });
    const { port, evidence } = await f.runtime();
    expect((await evidence.snapshot((await port.read()).goal)).stageActivity()).toEqual([]);
    /** A command that failed is not a receipt: it must not read as this stage's progress. */
    evidence.observe(tool({ call_id: "failed-check", result: JSON.stringify({ exit_code: 1 }) }));
    expect((await evidence.snapshot((await port.read()).goal)).stageActivity()).toEqual([]);
    evidence.observe(tool());
    const snapshot = await evidence.snapshot((await port.read()).goal);
    expect(snapshot.stageActivity()).toHaveLength(1);
    /** Receipts are a set: the same check repeated under another call id adds nothing. */
    evidence.observe(tool({ call_id: "another", arguments: { command: "bun run verify" } }));
    expect((await evidence.snapshot((await port.read()).goal)).stageActivity()).toEqual(
      snapshot.stageActivity(),
    );
  });

  it("refuses caller-selected authority and oversized evidence without publishing model state", async () => {
    const f = await fixture();
    const { port, evidence } = await f.runtime();
    const forged = { summary: "Foreign authority", evidence_ids: [], goal_id: "foreign" };
    await expect(port.progress(forged)).rejects.toMatchObject({ code: "invalid_request" });
    evidence.observe(tool({ result: "x".repeat(1024 * 1024 + 1) }));
    expect(await port.read()).toMatchObject({
      evidence: [],
    });
    expect((await port.read()).evidence_unavailable).toBeUndefined();
    evidence.observe(tool({ call_id: "usable", arguments: { command: "independent" } }));
    expect((await port.read()).evidence).toHaveLength(1);
    expect((await f.repository.read("session"))!.current!.runs[0]!.progress).toBeUndefined();
    expect(f.changes).toEqual([]);
  });

  it("refuses an unusable evidence set as corrigible input without writing anything", async () => {
    const f = await fixture({ criteria: [toolCriterion] });
    const { port, evidence } = await f.runtime();
    evidence.observe(tool());
    const known = (await port.read()).evidence[0]!.id;
    const before = structuredClone((await f.repository.read("session"))!.current!);
    const unacceptable = [["tool-absent"], [known, known], [known, "tool-absent"]];
    for (const evidence_ids of unacceptable)
      expect(await port.progress({ summary: "Inspected the work", evidence_ids })).toMatchObject({
        kind: "invalid",
      });
    for (const evidence_ids of unacceptable)
      expect(
        await port.checkpoint({ summary: "Stage ended", next_step: "Continue", evidence_ids }),
      ).toMatchObject({ kind: "invalid" });
    /**
     * A list past the advertised bound is refused by the schema before the port sees it, which
     * is one of the arguments the capability answers as corrigible tool input.
     */
    await expect(
      port.progress({
        summary: "Inspected the work",
        evidence_ids: Array.from({ length: 9 }, (_, index) => `tool-${index}`),
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    /** A candidate is refused as a whole: one unusable identifier leaves nothing recorded. */
    expect(await port.candidate(candidate("check", "host", [known, "tool-absent"]))).toMatchObject({
      kind: "invalid",
    });

    const after = (await f.repository.read("session"))!.current!;
    expect(after.revision).toBe(before.revision);
    expect(after.runs[0]!.progress).toBeUndefined();
    expect(after.runs[0]!.checkpoint).toBeUndefined();
    expect(after.runs[0]!.candidate).toBeUndefined();
    expect(f.changes).toEqual([]);

    // A usable set still resolves, so the refusal was about the identifiers and nothing else.
    expect(
      await port.progress({ summary: "Inspected the work", evidence_ids: [known] }),
    ).toMatchObject({ kind: "ok" });
  });
});

it("projects bounded sanitized command receipts from current and prior Goal stages only", async () => {
  const event = tool({
    arguments: { command: "bun run verify", cwd: ".", token: "private-fixture-value" },
    result: JSON.stringify({
      exit_code: 0,
      stdout: "All checks passed\n" + "case passed\n".repeat(400),
      stderr: "",
    }),
  });
  const f = await fixture({ readTrace: (id) => (id === "first" ? [event] : undefined) });
  const first = await f.runtime();
  first.evidence.observe(event);
  const current = await first.evidence.snapshot((await first.port.read()).goal);
  const receipt = current.commands[0]!;
  expect(receipt).toMatchObject({
    id: current.catalog[0]!.id,
    tool: "shell",
    exit_code: 0,
    truncated: true,
  });
  expect(receipt.arguments_excerpt).toContain("bun run verify");
  expect(receipt.arguments_excerpt).not.toContain("private-fixture-value");
  expect(receipt.stdout_excerpt).toStartWith("All checks passed");
  expect(receipt.stdout_excerpt.length).toBe(3072);
  await first.port.checkpoint({
    summary: "Verified",
    next_step: "Report",
    evidence_ids: [receipt.id],
  });
  await settle(f);
  await f.admit("second");
  const second = await f.runtime("second");
  expect((await second.evidence.snapshot((await second.port.read()).goal)).commands).toEqual([
    receipt,
  ]);
  second.evidence.observe(
    tool({
      call_id: "failed-recheck",
      arguments: event.arguments,
      result: JSON.stringify({ exit_code: 1, stdout: "FAILED" }),
    }),
  );
  expect((await second.evidence.snapshot((await second.port.read()).goal)).commands).toEqual([]);
});

it("uses a pre-cap command receipt when the persisted display result is truncated", async () => {
  const fullResult = JSON.stringify({
    exit_code: 0,
    stdout: "CHECK_EXECUTED_OK\n" + "detail\n".repeat(2000),
    stderr: "",
  });
  const event = tool({
    result: `${fullResult.slice(0, 5000)}...[truncated]`,
    result_digest: createHash("sha256").update(fullResult).digest("hex"),
    tool_evidence: {
      kind: "command",
      status: "succeeded",
      total_chars: fullResult.length,
      excerpt: fullResult.slice(0, 8192),
      truncated: true,
      command: {
        exit_code: 0,
        stdout_excerpt: "CHECK_EXECUTED_OK\n" + "detail\n".repeat(400),
        stderr_excerpt: "",
      },
    },
  });
  const f = await fixture();
  const first = await f.runtime();
  first.evidence.observe(event);
  const snapshot = await first.evidence.snapshot((await first.port.read()).goal);
  expect(snapshot.commands).toHaveLength(1);
  expect(snapshot.commands[0]).toMatchObject({
    exit_code: 0,
    stdout_excerpt: expect.stringContaining("CHECK_EXECUTED_OK"),
  });
  expect(snapshot.details[0]).toMatchObject({
    kind: "command",
    status: "succeeded",
    digest: event.result_digest,
    truncated: true,
  });
});

it("projects completed delegation receipts from current and prior Goal stages", async () => {
  const event = delegation({ result: "delegation result line\n".repeat(300) });
  const f = await fixture({ readTrace: (id) => (id === "first" ? [event] : undefined) });
  const first = await f.runtime();
  first.evidence.observe(event);
  const current = await first.evidence.snapshot((await first.port.read()).goal);
  expect(current.delegations).toHaveLength(1);
  expect(current.delegations[0]).toMatchObject({
    id: current.catalog[0]!.id,
    tool: "delegate_task",
    status: "completed",
    truncated: true,
  });
  expect(current.delegations[0]!.result_excerpt).toHaveLength(4096);
  await first.port.checkpoint({ summary: "Delegated", next_step: "Verify", evidence_ids: [] });
  await settle(f);
  await f.admit("second");
  const second = await f.runtime("second");
  expect((await second.evidence.snapshot((await second.port.read()).goal)).delegations).toEqual(
    current.delegations,
  );
});
