import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuiltinTraceEvent } from "@clarvis/capability";
import { advanceGoalRun, settleGoalRun, type GoalCriterion } from "@clarvis/goal";
import { mapEntry } from "@clarvis/trace";
import { goalEvidenceDigest } from "../../src/goals/evidence.ts";
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
type ToolEvent = Extract<BuiltinTraceEvent, { type: "tool_call" }>;
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
      usage: { kind: "measured", input: 100, cached: 80, output: 5 },
      now: 500,
    }),
    result: undefined,
  }));
}

describe("durable host goal runtime port", () => {
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
    for (const name of ["get_goal", "update_goal", "agent_status", "monitor_poll"])
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
    expect(remote.description).toStartWith("remote.shell;");
    expect(await port.candidate(candidate("check", "host", [remote.id]))).toMatchObject({
      valid: false,
    });
    evidence.observe(mapped("shell", JSON.stringify({ exit_code: 0 })));
    const native = (await port.read()).evidence.find((ref) =>
      ref.description.startsWith("shell;"),
    )!;
    expect(native).toBeDefined();
    expect(await port.candidate(candidate("check", "host", [native.id]))).toMatchObject({
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
      await port.checkpoint({
        summary: "Stage ended",
        next_step: "Check result",
        evidence_ids: [],
      }),
    ).toMatchObject({ progress_accepted: false });
    expect(await port.candidate(candidate())).toMatchObject({
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
    expect(await port.candidate(candidate("check", "host", [unrelated.id]))).toMatchObject({
      valid: false,
    });
    evidence.observe(tool());
    const ref = (await port.read()).evidence.find((ref) => ref.description.endsWith("call check"))!;
    expect(await port.candidate(candidate("check", "host", [ref.id]))).toMatchObject({
      valid: true,
    });
    evidence.observe(
      tool({ call_id: "later", result: JSON.stringify({ exit_code: 1 }), error: null }),
    );
    expect(await port.validateCompletion()).toMatchObject({ valid: false });
    await expect(
      port.progress({ summary: "Obsolete success", evidence_ids: [ref.id] }),
    ).rejects.toMatchObject({ code: "invalid_request" });
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
    expect(await port.candidate(candidate("check", "host"))).toMatchObject({ valid: false });
  });

  it("rejects fabricated references and stamps valid scope without leaking catalog metadata into state", async () => {
    const f = await fixture();
    const { port, evidence } = await f.runtime();
    evidence.observe(tool());
    const snapshot = await port.read();
    const ref = snapshot.evidence[0]!;
    await expect(
      port.progress({ summary: "Invented", evidence_ids: ["foreign-run-proof"] }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      port.progress({ summary: "Repeated", evidence_ids: [ref.id, ref.id] }),
    ).rejects.toMatchObject({ code: "invalid_request" });
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
    expect(await port.candidate(candidate("artifact", "host", [ref.id]))).toMatchObject({
      valid: true,
    });
    const snapshot = await evidence.snapshot(goal);
    await writeFile(join(f.workspaceRoot, "result.txt"), "changed");
    expect(
      await snapshot.verify(ref, { id: "q", kind: "qualitative", description: "q" }),
    ).toMatchObject({ valid: false });
    expect(await port.validateCompletion()).toMatchObject({ valid: false });
    await expect(port.candidate(candidate("artifact", "host", [ref.id]))).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect((await port.read()).evidence[0]!.id).not.toBe(ref.id);
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
    expect(await port.candidate(candidate("artifact", "host"))).toMatchObject({ valid: false });
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
    expect(await port.candidate(candidate("review", "human"))).toMatchObject({ valid: false });
    await f.control({ kind: "accept", criterion_id: "review", objective_revision: 1 });
    expect(await port.validateCompletion()).toMatchObject({
      valid: true,
      qualitative_criteria: [],
    });
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
    expect((await f.reopen().get("session"))!.goal_state!.current!.status).toBe("blocked");
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
    expect(checkpoint.progress_accepted).toBe(true);
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
      await second.port.checkpoint({
        summary: "Checked again",
        next_step: "Continue again",
        evidence_ids: [newRef.id],
      }),
    ).toMatchObject({ progress_accepted: false });
    events.push(tool({ result: JSON.stringify({ exit_code: 1 }) }));
    await expect(second.port.read()).rejects.toMatchObject({ code: "conflict" });
  });

  it("fails closed on ambiguous or overflowing live observations and excludes polling", async () => {
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
    await expect(port.read()).rejects.toMatchObject({ code: "resource_exhausted" });
    const overflow = await f.runtime();
    for (let i = 0; i <= 512; i++) overflow.evidence.observe(tool({ call_id: `call-${i}` }));
    await expect(overflow.port.read()).rejects.toMatchObject({ code: "resource_exhausted" });
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
    expect(await second.port.candidate(candidate("check", "host"))).toMatchObject({ valid: false });
  });

  it("refuses caller-selected authority and oversized evidence without publishing model state", async () => {
    const f = await fixture();
    const { port, evidence } = await f.runtime();
    const forged = { summary: "Foreign authority", evidence_ids: [], goal_id: "foreign" };
    await expect(port.progress(forged)).rejects.toMatchObject({ code: "invalid_request" });
    evidence.observe(tool({ result: "x".repeat(1024 * 1024 + 1) }));
    await expect(port.read()).rejects.toMatchObject({ code: "resource_exhausted" });
    expect((await f.repository.read("session"))!.current!.runs[0]!.progress).toBeUndefined();
    expect(f.changes).toEqual([]);
  });
});
