import { describe, expect, test } from "bun:test";
import {
  planCanonicalState,
  planCasHeader,
  planSpecBlock,
} from "../../src/capability/canonical-state.ts";
import { MAX_PLAN_TASKS, MAX_PLAN_TITLE_CHARS } from "../../src/limits.ts";
import { planDocumentSchema, type PlanTaskStatus } from "../../src/schemas.ts";
import { PlanSession } from "../../src/capability/session.ts";
import { createPlanStore } from "../../src/index.ts";
import { createInMemoryPlanRepository } from "../../src/testing.ts";

async function planned(taskCount = 2): Promise<PlanSession> {
  const session = new PlanSession({
    store: createPlanStore({ repository: createInMemoryPlanRepository() }),
    executionId: "run-1",
    review: false,
  });
  await session.create({
    title: "Anchor",
    objective: "Keep the plan in context",
    context: "the file is the authority",
    tasks: Array.from({ length: taskCount }, (_, index) =>
      index === 0 ? { title: "First", detail: "do it" } : { title: `Task ${index + 1}` },
    ),
    validation: ["tests pass"],
  });
  return session;
}

const OPERATIONAL_GUIDANCE =
  "Keep the plan current. Mark direct work in_progress first. Record outcomes with transition_plan_task when exit criteria are met. Review returned and failed tasks before completion.";

function withStatuses(
  document: NonNullable<ReturnType<PlanSession["cached"]>>,
  statuses: readonly PlanTaskStatus[],
) {
  return {
    ...document,
    tasks: document.tasks.map((task, index) => ({ ...task, status: statuses[index]! })),
  };
}

describe("plan canonical state", () => {
  test("carries the compare-and-swap triple the mutating tools demand", async () => {
    const session = await planned();
    const document = session.cached()!;
    const body = planCanonicalState(document, false);

    expect(body).toContain(`expected_revision: ${document.revision}`);
    expect(body).toContain(`expected_digest: ${document.digest}`);
    expect(body).toContain(`expected_spec_digest: ${document.spec_digest}`);
    expect(body).toContain(`Plan file: ${document.path}`);
    expect(body).toContain("Plan name: Anchor");
  });

  test("renders all three empty categories", async () => {
    const session = await planned(0);
    const header = planCasHeader(session.cached()!, false);

    expect(header).toContain("Tasks requiring attention: none.");
    expect(header).toContain("Pending tasks: none.");
    expect(header).toContain("Closed tasks: none.");
  });

  test("classifies the normative five-task example without duplication", async () => {
    const session = await planned(5);
    const document = withStatuses(session.cached()!, [
      "done",
      "done",
      "pending",
      "in_progress",
      "returned",
    ]);
    const header = planCasHeader(document, false);

    expect(header).toContain("Tasks requiring attention: t4 (in_progress), t5 (returned)");
    expect(header).toContain("Pending tasks: t3 (pending)");
    expect(header).toContain("Closed tasks: t1 (done), t2 (done)");
    for (const task of document.tasks)
      expect(header.match(new RegExp(`${task.id} \\(`, "g"))).toHaveLength(1);
  });

  test("classifies every status exactly once while preserving document order", async () => {
    const session = await planned(6);
    const document = withStatuses(session.cached()!, [
      "failed",
      "pending",
      "returned",
      "abandoned",
      "in_progress",
      "done",
    ]);
    const header = planCasHeader(document, false);

    expect(header).toContain(
      "Tasks requiring attention: t1 (failed), t3 (returned), t5 (in_progress)",
    );
    expect(header).toContain("Pending tasks: t2 (pending)");
    expect(header).toContain("Closed tasks: t4 (abandoned), t6 (done)");
  });

  test("category lines contain only task ids and statuses", async () => {
    const session = await planned();
    const document = {
      ...withStatuses(session.cached()!, ["returned", "failed"]),
      tasks: withStatuses(session.cached()!, ["returned", "failed"]).tasks.map((task, index) => ({
        ...task,
        title: `SECRET TITLE ${index}`,
        detail: "SECRET DETAIL",
        exit: "SECRET EXIT",
        result: "SECRET RESULT",
      })),
    };
    const categoryLines = planCasHeader(document, false)
      .split("\n")
      .filter((line) => /^(Tasks requiring attention|Pending tasks|Closed tasks):/.test(line));

    expect(categoryLines).toEqual([
      "Tasks requiring attention: t1 (returned), t2 (failed)",
      "Pending tasks: none.",
      "Closed tasks: none.",
    ]);
    expect(categoryLines.join("\n")).not.toContain("SECRET");
  });

  test("projects the plan name onto one bounded line without mutating the document", async () => {
    const session = await planned();
    const document = { ...session.cached()!, title: `${"😀".repeat(260)}\r\nsecond line` };
    const original = document.title;
    const nameLine = planCasHeader(document, false).split("\n")[1]!;

    expect(Array.from(nameLine.slice("Plan name: ".length))).toHaveLength(256);
    expect(nameLine).not.toContain("\r");
    expect(nameLine).not.toContain("\n");
    expect(document.title).toBe(original);
  });

  test("keeps the invariant operational guidance within 240 Unicode characters", async () => {
    const session = await planned();
    const header = planCasHeader(session.cached()!, false);

    expect(header.split("\n").at(-1)).toBe(OPERATIONAL_GUIDANCE);
    expect(Array.from(OPERATIONAL_GUIDANCE).length).toBeLessThanOrEqual(240);
    expect(OPERATIONAL_GUIDANCE).toContain("Mark direct work in_progress first");
    expect(OPERATIONAL_GUIDANCE).not.toContain("Call spawn_subagent");
    expect(OPERATIONAL_GUIDANCE).toContain("transition_plan_task");
  });

  test("the largest valid compact header fits without omitting any task", async () => {
    const session = await planned(MAX_PLAN_TASKS);
    const base = session.cached()!;
    const document = planDocumentSchema.parse({
      ...base,
      title: "x".repeat(MAX_PLAN_TITLE_CHARS),
      tasks: base.tasks.map((task, index) => ({
        ...task,
        id: `t${String(index + 1).padEnd(31, "0")}`,
      })),
    });
    const header = planCasHeader(document, false);

    expect(Array.from(header).length).toBeLessThanOrEqual(32_768);
    for (const task of document.tasks) expect(header).toContain(`${task.id} (${task.status})`);
  });

  test("embeds the whole document so the model reads the real Markdown", async () => {
    const session = await planned();
    const body = planCanonicalState(session.cached()!, false);
    expect(body).toContain("## Tasks");
    expect(body).toContain("- [ ] (t1) First");
    expect(body).toContain("  - Detail: do it");
    expect(body).toContain("Keep the plan in context");
  });

  test("the triple tracks each write, so a stale anchor can never be re-sent", async () => {
    const session = await planned();
    const before = planCanonicalState(session.cached()!, false);
    await session.transitionCurrent({ taskId: "t1", status: "in_progress" });
    const after = planCanonicalState(session.cached()!, false);

    expect(after).not.toBe(before);
    expect(after).toContain(`expected_revision: ${session.cached()!.revision}`);
    expect(after).toContain(`expected_digest: ${session.cached()!.digest}`);
  });

  describe("the split between the volatile header and the stable spec block", () => {
    /**
     * The load-bearing property of the whole split. The spec block sits at a
     * fixed position behind the cache breakpoint, so it must be byte-stable
     * across the mutations that happen constantly — task transitions. It mirrors
     * `@clarvis/plan`'s own `specDigest` field set, which is why `spec_digest` is
     * the right thing to tie the assertion to.
     */
    test("the spec block is byte-identical across task transitions, exactly as spec_digest is", async () => {
      const session = await planned();
      const before = session.cached()!;
      const beforeBlock = planSpecBlock(before);

      await session.transitionCurrent({ taskId: "t1", status: "in_progress" });
      await session.transitionCurrent({ taskId: "t1", status: "done", result: "did it" });
      const after = session.cached()!;

      expect(after.revision).toBeGreaterThan(before.revision);
      expect(after.spec_digest).toBe(before.spec_digest);
      expect(planSpecBlock(after)).toBe(beforeBlock);
    });

    test("the spec block does change when the plan's substance does", async () => {
      const session = await planned();
      const original = session.cached()!;
      const before = planSpecBlock(original);

      await session.revise(
        {
          revision: original.revision,
          digest: original.digest,
          specDigest: original.spec_digest,
        },
        { type: "set_objective", objective: "A different objective entirely" },
      );
      const after = session.cached()!;

      expect(after.spec_digest).not.toBe(original.spec_digest);
      expect(planSpecBlock(after)).not.toBe(before);
      expect(planSpecBlock(after)).toContain("A different objective entirely");
    });

    test("the spec block carries the substance and omits everything that moves", async () => {
      const session = await planned();
      await session.transitionCurrent({ taskId: "t1", status: "done", result: "did it" });
      const block = planSpecBlock(session.cached()!);

      expect(block).toContain("Keep the plan in context");
      expect(block).toContain("- (t1) First");
      expect(block).toContain("  Detail: do it");
      expect(block).toContain("- tests pass");
      expect(block).not.toContain("expected_digest");
      expect(block).not.toContain("Result:");
      expect(block).not.toContain("revision:");
      expect(block).not.toContain("[x]");
    });

    test("the header carries the CAS triple and every task status, but not the document", async () => {
      const session = await planned();
      await session.transitionCurrent({ taskId: "t1", status: "done", result: "did it" });
      const document = session.cached()!;
      const header = planCasHeader(document, false);

      expect(header).toContain(`expected_spec_digest: ${document.spec_digest}`);
      expect(header).toContain("Tasks requiring attention: none.");
      expect(header).toContain("Pending tasks: t2 (pending)");
      expect(header).toContain("Closed tasks: t1 (done)");
      expect(header).not.toContain("## Objective");
      expect(header).not.toContain("- [x] (t1)");
      expect(Array.from(header).length).toBeLessThanOrEqual(32_768);
    });

    /** The compaction anchor must keep the whole document, unlike the tail. */
    test("planCanonicalState still composes the header with the full rendered plan", async () => {
      const session = await planned();
      const document = session.cached()!;
      const body = planCanonicalState(document, false);

      expect(body.startsWith(planCasHeader(document, false))).toBe(true);
      expect(body).toContain("- [ ] (t1) First");
      expect(body).toContain("## Notes");
    });
  });

  describe("the approval line reports the run's posture, not the document's status", () => {
    test("a run without the gate never claims an approval is pending", async () => {
      const session = await planned();
      expect(planCanonicalState(session.cached()!, false)).toContain(
        "Approval: not required for this run.",
      );
    });

    test("a gated run with no approval on this revision says so", async () => {
      const session = await planned();
      expect(planCanonicalState(session.cached()!, true)).toContain("AWAITING HUMAN APPROVAL");
    });

    test("a gated run that holds the approval warns what revising costs", async () => {
      const session = await planned();
      await session.approve();
      const body = planCanonicalState(session.cached()!, true);
      expect(body).toContain("approved at this revision");
      expect(body).toContain("revokes the approval");
    });

    /**
     * A cancelled review run leaves the plan at `awaiting_approval`; continuation
     * resets that to `active` while the gate is still on. Reading the posture off
     * the status told the model the opposite of what the runtime enforced.
     */
    test("an active status in a gated run still reports the gate", async () => {
      const session = await planned();
      expect(session.cached()!.status).toBe("active");
      expect(planCanonicalState(session.cached()!, true)).not.toContain("not required");
    });
  });
});
