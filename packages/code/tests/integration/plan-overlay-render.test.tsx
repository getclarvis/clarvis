import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { rgbToHex } from "@opentui/core";
import type { PlanDocumentDto, PlansService } from "@clarvis/protocol";
import { PlanOverlay } from "../../src/views/overlays/PlanOverlay.tsx";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { PlanActivity } from "../../src/adapters/activity-store.ts";
import { tokens } from "../../src/theme/tokens.ts";
import { selectionBg } from "../../src/theme/surfaces.ts";
import { captureUntil } from "../helpers/render-support.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

function fakeInteraction(): { interaction: Interaction; press: (key: string) => void } {
  const { keymap, press } = createFakeKeymap();
  return {
    interaction: {
      keymap,
      pushOverlayContext: () => {},
      popOverlayContext: () => {},
      syncContext: () => {},
    } as unknown as Interaction,
    press,
  };
}

const PLAN: PlanActivity = {
  id: ".clarvis/plans/cart.md",
  path: ".clarvis/plans/cart.md",
  title: "Cart flow",
  status: "active",
  retention: "keep",
  revision: 2,
  spec_revision: 2,
  tasks: [
    {
      id: "t1",
      title: "Map architecture and entry point",
      status: "done",
      description: "Read main.jsx and App.jsx",
    },
    {
      id: "t2",
      title: "Map cart state",
      status: "in_progress",
      exit_condition: "understands the reducer",
    },
  ],
};

async function mount(
  plan: PlanActivity | null,
  ready?: string,
  plans?: PlansService,
  origin?: "direct" | "history",
) {
  const { interaction, press } = fakeInteraction();
  const t = await openRender(
    (() => (
      <PlanOverlay interaction={interaction} plan={() => plan} plans={plans} origin={origin} />
    )) as never,
    {
      width: 100,
      height: 30,
    },
  );
  await t.renderOnce();
  if (ready) await captureUntil(t, ready);
  return { t, press };
}

function document(path: string, title: string, status: PlanDocumentDto["status"]): PlanDocumentDto {
  return {
    path,
    id: path,
    title,
    status,
    retention: "keep",
    revision: 1,
    spec_revision: 1,
    created_at: "2026-07-25T00:00:00Z",
    updated_at: "2026-07-25T00:00:00Z",
    created_by_run: "run-1",
    objective: title,
    context: "",
    tasks: [],
    validation: [],
    notes: "",
    markdown: `# ${title}\n\nDetail for ${title}.`,
  };
}

async function frame(plan: PlanActivity | null, waitFor: string): Promise<string> {
  const { t } = await mount(plan);
  const out = await captureUntil(t, waitFor);
  t.renderer.destroy();
  return out;
}

test("overlay auto-selects the in_progress task and shows detail only for it", async () => {
  const out = await frame(PLAN, "understands the reducer");
  expect(out).toContain("Plans · Running · 1/2 tasks done");
  expect(out).toContain("Map architecture and entry point");
  expect(out).not.toContain("Read main.jsx and App.jsx");
  expect(out).toContain("Map cart state");
  expect(out).toContain("understands the reducer");
});

test("navigating to another task moves the detail with the selection", async () => {
  const { t, press } = await mount(PLAN, "understands the reducer");
  press("up");
  const out = await captureUntil(t, "Read main.jsx and App.jsx");
  expect(out).toContain("Read main.jsx and App.jsx");
  expect(out).not.toContain("understands the reducer");
  t.renderer.destroy();
});

test("a returned task auto-selects and shows its result — the lead's judgment material", async () => {
  const out = await frame(
    {
      id: ".clarvis/plans/returned.md",
      path: ".clarvis/plans/returned.md",
      title: "Returned",
      status: "active",
      retention: "keep",
      revision: 4,
      spec_revision: 2,
      tasks: [
        { id: "a", title: "Ship the adapter", status: "done", result: "merged in r3" },
        {
          id: "b",
          title: "Wire the projection",
          status: "returned",
          assignee: "coder",
          result: "projection wired; sidebar untested",
        },
        { id: "c", title: "Render the overlay", status: "pending" },
      ],
    },
    "projection wired; sidebar untested",
  );
  expect(out).toContain("result");
  expect(out).toContain("projection wired; sidebar untested");
  expect(out).toContain("coder");
  expect(out).not.toContain("merged in r3");
});

test("a failed task shows its error and an abandoned one its reason", async () => {
  const failed = await frame(
    {
      id: ".clarvis/plans/failed.md",
      path: ".clarvis/plans/failed.md",
      title: "Failed",
      status: "failed",
      retention: "keep",
      revision: 2,
      spec_revision: 1,
      tasks: [{ id: "a", title: "Run the suite", status: "failed", error: "bun test exited 1" }],
    },
    "bun test exited 1",
  );
  expect(failed).toContain("error");
  expect(failed).toContain("bun test exited 1");

  const abandoned = await frame(
    {
      id: ".clarvis/plans/abandoned.md",
      path: ".clarvis/plans/abandoned.md",
      title: "Abandoned",
      status: "completed",
      retention: "keep",
      revision: 2,
      spec_revision: 1,
      tasks: [
        { id: "a", title: "Migrate the store", status: "abandoned", reason: "superseded by t2" },
      ],
    },
    "superseded by t2",
  );
  expect(abandoned).toContain("reason");
  expect(abandoned).toContain("superseded by t2");
});

test("plan overlay shows task detail without reading the filesystem", async () => {
  const out = await frame(
    {
      id: ".clarvis/plans/one.md",
      path: ".clarvis/plans/one.md",
      title: "One",
      status: "active",
      retention: "keep",
      revision: 0,
      spec_revision: 0,
      tasks: [{ id: "t1", title: "Task one", status: "pending" }],
    },
    "Task one",
  );
  expect(out).toContain("Task one");
});

test("the progress summary distinguishes completed tasks from ones that did not run", async () => {
  const out = await frame(
    {
      id: ".clarvis/plans/settled.md",
      path: ".clarvis/plans/settled.md",
      title: "Settled",
      status: "completed",
      retention: "keep",
      revision: 1,
      spec_revision: 1,
      tasks: [
        { id: "a", title: "A", status: "abandoned", reason: "r" },
        { id: "b", title: "B", status: "abandoned", reason: "r" },
        { id: "c", title: "C", status: "abandoned", reason: "r" },
      ],
    },
    "0/3 done · 3 not run",
  );
  expect(out).toContain("0/3 done · 3 not run");
});

test("pending/in_progress tasks are not counted as settled", async () => {
  const out = await frame(
    {
      id: ".clarvis/plans/pending.md",
      path: ".clarvis/plans/pending.md",
      title: "Pending",
      status: "active",
      retention: "discard",
      revision: 1,
      spec_revision: 1,
      tasks: [
        { id: "a", title: "A", status: "done", result: "ok" },
        { id: "b", title: "B", status: "pending" },
        { id: "c", title: "C", status: "in_progress" },
      ],
    },
    "1/3",
  );
  expect(out).toContain("1/3 tasks done");
});

test("a completed plan expands its outcome without marking the last task as current", async () => {
  const out = await frame(
    {
      id: ".clarvis/plans/complete.md",
      path: ".clarvis/plans/complete.md",
      title: "Complete",
      status: "completed",
      retention: "keep",
      revision: 4,
      spec_revision: 1,
      tasks: [
        { id: "final", title: "Verify release", status: "done", result: "all checks passed" },
      ],
    },
    "all checks passed",
  );
  expect(out).toContain("✓ Verify release");
  expect(out).not.toContain("▸ ✓ Verify release");
});

test("plan overlay falls back when there is no plan", async () => {
  const out = await frame(null, "no plans yet");
  expect(out).toContain("no plans yet");
  expect(out).toContain("start a task with planning enabled");
  expect(out).not.toContain("open detail");
  expect(out).not.toContain("keep/delete");
});

test("history navigation reads selected details through PlansService", async () => {
  const first = document(".clarvis/plans/first.md", "First plan", "completed");
  const second = document(".clarvis/plans/second.md", "Second plan", "cancelled");
  const reads: string[] = [];
  const plans: PlansService = {
    list: async () => ({ plans: [first, second] }),
    read: async (id) => {
      reads.push(id);
      return id === first.id ? first : second;
    },
    setRetention: async () => first,
    delete: async (id) => ({ id, deleted: true }),
  };
  const { t, press } = await mount(null, "First plan", plans);
  press("down");
  await captureUntil(t, "Second plan");
  press("return");
  const out = await captureUntil(t, "Detail for Second plan");
  expect(out).toContain("Second plan");
  expect(out).not.toContain("history · 2 plans");
  expect(reads).toEqual([first.id, second.id]);
  t.renderer.destroy();
});

test("the active plan is located and read by id even when no path exists", async () => {
  const { path: _path, ...base } = document("unused.md", "Remote plan", "active");
  const remote: PlanDocumentDto = { ...base, id: "remote-plan-42" };
  const reads: string[] = [];
  const plans: PlansService = {
    list: async () => ({ plans: [remote] }),
    read: async (id) => {
      reads.push(id);
      return remote;
    },
    setRetention: async () => remote,
    delete: async (id) => ({ id, deleted: true }),
  };
  const live: PlanActivity = {
    id: "remote-plan-42",
    title: "Remote plan",
    status: "active",
    retention: "keep",
    revision: 1,
    spec_revision: 1,
    tasks: [],
  };
  const { t } = await mount(live, "remote-plan-42", plans);
  expect(reads).toEqual(["remote-plan-42"]);
  expect(t.captureCharFrame()).not.toContain("undefined");
  t.renderer.destroy();
});

test("a plan entered from history returns to history on Escape", async () => {
  const doc = document(PLAN.id, PLAN.title, "active");
  const plans: PlansService = {
    list: async () => ({ plans: [doc] }),
    read: async () => doc,
    setRetention: async () => doc,
    delete: async (id) => ({ id, deleted: true }),
  };
  const { t, press } = await mount(PLAN, "Plans · History", plans, "history");
  press("return");
  await captureUntil(t, `Detail for ${PLAN.title}`);
  expect(t.captureCharFrame()).toContain("] scroll");
  press("escape");
  const history = await captureUntil(t, "open detail");
  expect(history).toContain("open detail");
  t.renderer.destroy();
});

test("a directly opened plan returns to its run on Escape", async () => {
  const doc = document(PLAN.id, PLAN.title, "awaiting_approval");
  const plans: PlansService = {
    list: async () => ({ plans: [doc] }),
    read: async () => doc,
    setRetention: async () => doc,
    delete: async (id) => ({ id, deleted: true }),
  };
  const { interaction, press } = fakeInteraction();
  let closed = 0;
  const t = await openRender(
    (() => (
      <PlanOverlay
        interaction={interaction}
        plan={() => ({ ...PLAN, status: "awaiting_approval" })}
        plans={plans}
        origin="direct"
        onClose={() => closed++}
      />
    )) as never,
    { width: 100, height: 30 },
  );
  await captureUntil(t, `Detail for ${PLAN.title}`);
  press("escape");
  expect(closed).toBe(1);
  t.renderer.destroy();
});

test("PlanOverlay leaves Ctrl+C to the global cancel-or-quit command", async () => {
  const { interaction, press } = fakeInteraction();
  let closed = 0;
  const t = await openRender(
    (() => (
      <PlanOverlay
        interaction={interaction}
        plan={() => PLAN}
        origin="direct"
        onClose={() => closed++}
      />
    )) as never,
    { width: 100, height: 30 },
  );
  await t.renderOnce();
  press("ctrl+c");
  expect(closed).toBe(0);
  t.renderer.destroy();
});

test("a missing active id warns and never opens another history document as active", async () => {
  const other = document("other.md", "Another document", "completed");
  const reads: string[] = [];
  const plans: PlansService = {
    list: async () => ({ plans: [other] }),
    read: async (id) => {
      reads.push(id);
      return other;
    },
    setRetention: async () => other,
    delete: async (id) => ({ id, deleted: true }),
  };
  const live: PlanActivity = {
    id: "active-elsewhere",
    title: "Active elsewhere",
    status: "active",
    retention: "keep",
    revision: 1,
    spec_revision: 1,
    tasks: [{ id: "t1", title: "Keep working", status: "in_progress" }],
  };
  const { t } = await mount(live, "selected provider's current history page", plans);
  const frame = t.captureCharFrame();
  expect(frame).toContain("active-elsewhere");
  expect(frame).toContain("selected provider's current history page");
  expect(frame).toContain("Keep working");
  expect(frame).not.toContain("Detail for Another document");
  expect(reads).toEqual(["active-elsewhere"]);
  t.renderer.destroy();
});

test("history filters and pagination are delegated to PlansService", async () => {
  const first = document(".clarvis/plans/first.md", "First plan", "completed");
  const calls: unknown[] = [];
  const plans: PlansService = {
    list: async (input) => {
      calls.push(input);
      return { plans: [first], next_cursor: calls.length === 1 ? "next-page" : undefined };
    },
    read: async () => first,
    setRetention: async () => first,
    delete: async (id) => ({ id, deleted: true }),
  };
  const { t, press } = await mount(null, "First plan", plans);
  press("]");
  await t.renderOnce();
  press("f");
  await captureUntil(t, "status:active");
  press("t");
  await captureUntil(t, "retention:keep");
  expect(calls).toContainEqual({ limit: 8, cursor: "next-page" });
  expect(calls).toContainEqual({ limit: 8, status: "active" });
  expect(calls).toContainEqual({ limit: 8, status: "active", retention: "keep" });
  t.renderer.destroy();
});

async function approvalFrame(doc: PlanDocumentDto): Promise<string> {
  const plans: PlansService = {
    list: async () => ({ plans: [doc] }),
    read: async () => doc,
    setRetention: async () => doc,
    delete: async () => ({ id: doc.id, deleted: true }),
  };
  const { t, press } = await mount(null, doc.title, plans);
  press("return");
  const out = await captureUntil(t, "Detail for " + doc.title);
  t.renderer.destroy();
  return out;
}

test("an unapproved plan says approval is pending and names the spec revision", async () => {
  const doc = {
    ...document(".clarvis/plans/a.md", "Needs approval", "awaiting_approval"),
    spec_revision: 2,
  };
  const out = await approvalFrame(doc);
  expect(out).toContain("Human approval needed for specification #2");
  expect(out).toContain("Execution update #1 · specification #2");
});

test("an approved plan names the specification the human bound to", async () => {
  const doc = {
    ...document(".clarvis/plans/b.md", "Approved plan", "active"),
    spec_revision: 2,
    approved_spec_revision: 2,
  };
  const out = await approvalFrame(doc);
  expect(out).toContain("Human-approved specification #2");
  expect(out).toContain("Execution update #1 · specification #2");
});

test("a structural edit after approval reads as invalidated, not as approved", async () => {
  const doc = {
    ...document(".clarvis/plans/c.md", "Changed plan", "awaiting_approval"),
    spec_revision: 3,
    approved_spec_revision: 2,
  };
  const out = await approvalFrame(doc);
  expect(out).toContain("specification #3 changed after approval of specification #2");
  expect(out).toContain("Execution update #1 · specification #3");
});

test("a plan that never needed review does not claim an approval", async () => {
  const doc = document(".clarvis/plans/d.md", "Ungated plan", "active");
  expect(await approvalFrame(doc)).toContain("Human review was not required");
});

test("retention toggles through the service and terminal delete arms, then y confirms", async () => {
  const terminal = document(".clarvis/plans/done.md", "Done plan", "completed");
  const retentions: string[] = [];
  const deletes: string[] = [];
  const plans: PlansService = {
    list: async () => ({ plans: [terminal] }),
    read: async () => terminal,
    setRetention: async (id, retention) => {
      retentions.push(`${id}:${retention}`);
      return { ...terminal, retention };
    },
    delete: async (id) => {
      deletes.push(id);
      return { id, deleted: true };
    },
  };
  const { t, press } = await mount(null, "Done plan", plans);
  press("v");
  expect(await captureUntil(t, "Delete")).toContain("Done plan");
  press("d");
  await t.renderOnce();
  expect(deletes).toEqual([]);
  const armed = t.captureCharFrame();
  expect(armed).toContain('delete plan "Done plan"?');
  expect(armed).toContain("[y] confirm");
  expect(armed).toContain("[n/esc] cancel");
  press("y");
  await t.renderOnce();
  expect(retentions).toEqual([`${terminal.id}:discard`]);
  expect(deletes).toEqual([terminal.id]);
  t.renderer.destroy();
});

test("pathless retention and delete operations use only the stable id", async () => {
  const { path: _path, ...base } = document("unused.md", "Remote terminal", "completed");
  const remote: PlanDocumentDto = { ...base, id: "remote-terminal-7" };
  const calls: string[] = [];
  const plans: PlansService = {
    list: async () => ({ plans: [remote] }),
    read: async (id) => {
      calls.push(`read:${id}`);
      return remote;
    },
    setRetention: async (id, retention) => {
      calls.push(`retention:${id}:${retention}`);
      return { ...remote, retention };
    },
    delete: async (id) => {
      calls.push(`delete:${id}`);
      return { id, deleted: true };
    },
  };
  const { t, press } = await mount(null, "Remote terminal", plans);
  press("v");
  await captureUntil(t, "Delete");
  press("d");
  press("y");
  await t.renderOnce();
  expect(calls).toEqual([
    "read:remote-terminal-7",
    "retention:remote-terminal-7:discard",
    "delete:remote-terminal-7",
  ]);
  t.renderer.destroy();
});

test("n keeps the armed plan: nothing is deleted and the hint returns", async () => {
  const terminal = document(".clarvis/plans/done.md", "Done plan", "completed");
  const deletes: string[] = [];
  const plans: PlansService = {
    list: async () => ({ plans: [terminal] }),
    read: async () => terminal,
    setRetention: async () => terminal,
    delete: async (id) => {
      deletes.push(id);
      return { id, deleted: true };
    },
  };
  const { t, press } = await mount(null, "Done plan", plans);
  press("d");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("[y] confirm");
  press("n");
  await t.renderOnce();
  expect(deletes).toEqual([]);
  expect(t.captureCharFrame()).not.toContain("[y] confirm");
  t.renderer.destroy();
});

test("an armed delete never lands on a different plan than it was armed against", async () => {
  const first = document(".clarvis/plans/first.md", "First plan", "completed");
  const second = document(".clarvis/plans/second.md", "Second plan", "cancelled");
  const deletes: string[] = [];
  const plans: PlansService = {
    list: async () => ({ plans: [first, second] }),
    read: async (path) => (path === first.path ? first : second),
    setRetention: async () => first,
    delete: async (id) => {
      deletes.push(id);
      return { id, deleted: true };
    },
  };
  const { t, press } = await mount(null, "First plan", plans);
  press("d");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain('delete plan "First plan"?');

  const lines = t.captureCharFrame().split("\n");
  const y = lines.findIndex((l) => l.includes("Second plan"));
  const x = lines[y]!.indexOf("Second plan");
  await t.mockMouse.click(x, y);
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("[y] confirm");

  press("y");
  await captureUntil(t, "Second plan");
  expect(deletes).toEqual([]);

  press("d");
  await captureUntil(t, 'delete plan "Second plan"?');
  press("y");
  await t.renderOnce();
  expect(deletes).toEqual([second.id]);
  t.renderer.destroy();
});

test("a seeded plan renders its readable sections, not the frontmatter, once", async () => {
  const markdown = [
    "---",
    "id: demo",
    "title: Demo overhaul plan",
    "status: active",
    "---",
    "",
    "## Objective",
    "",
    "Ship the checkout redesign.",
    "",
    "## Context",
    "",
    "Cart flow regressed after the overhaul.",
    "",
    "## Tasks",
    "",
    "- [>] (t1) Wire the projection reducer",
    "- [ ] (t2) Render the overlay body",
    "",
    "## Validation",
    "",
    "- suite green before release",
    "",
  ].join("\n");
  const doc: PlanDocumentDto = {
    ...document(".clarvis/plans/demo.md", "Demo overhaul plan", "active"),
    markdown,
  };
  const plans: PlansService = {
    list: async () => ({ plans: [doc] }),
    read: async () => doc,
    setRetention: async () => doc,
    delete: async (id) => ({ id, deleted: true }),
  };
  const live: PlanActivity = {
    id: doc.id,
    path: doc.path,
    title: doc.title,
    status: "active",
    retention: "keep",
    revision: 1,
    spec_revision: 1,
    tasks: [
      { id: "t1", title: "Wire the projection reducer", status: "in_progress" },
      { id: "t2", title: "Render the overlay body", status: "pending" },
    ],
  };
  const { t } = await mount(live, "suite green before release", plans);
  const out = t.captureCharFrame();
  expect(out).toContain("Ship the checkout redesign.");
  expect(out).toContain("Cart flow regressed after the overhaul.");
  expect(out).toContain("suite green before release");
  expect(out).not.toContain("id: demo");
  expect(out.split("Wire the projection reducer").length - 1).toBe(1);
  t.renderer.destroy();
});

test("with a document shown, tab switches the second focus to document scroll", async () => {
  const doc: PlanDocumentDto = {
    ...document(".clarvis/plans/demo.md", "Demo overhaul plan", "active"),
    markdown: ["## Objective", "", "Ship it.", "", "## Validation", "", "- green"].join("\n"),
  };
  const plans: PlansService = {
    list: async () => ({ plans: [doc] }),
    read: async () => doc,
    setRetention: async () => doc,
    delete: async (id) => ({ id, deleted: true }),
  };
  const { t, press } = await mount(null, "Demo overhaul plan", plans);
  expect(t.captureCharFrame()).toContain("] move");
  press("return");
  const scrolled = await captureUntil(t, "] scroll");
  expect(scrolled).toContain("] scroll");
  expect(scrolled).not.toContain("] move");
  press("down");
  press("pagedown");
  await t.renderOnce();
  t.renderer.destroy();
});

test("history Enter survives a delete performed in document-scroll mode", async () => {
  const a = document(".clarvis/plans/a.md", "Plan Aaa", "completed");
  const b = document(".clarvis/plans/b.md", "Plan Bbb", "completed");
  const plans: PlansService = {
    list: async () => ({ plans: [a, b] }),
    read: async (path) => (path === a.path ? a : b),
    setRetention: async (path) => (path === a.path ? a : b),
    delete: async (id) => ({ id, deleted: true }),
  };
  const { t, press } = await mount(null, "Plan Aaa", plans);
  press("return"); // history -> detail; a document is shown, so this is scroll mode
  await captureUntil(t, "] scroll");
  press("d");
  press("y");
  await t.renderOnce();
  press("tab"); // tasks -> history: mode is unchanged (no doc) — must still re-register
  const backToHistory = await captureUntil(t, "open detail");
  expect(backToHistory).toContain("open detail");
  press("return");
  const opened = await captureUntil(t, "] scroll");
  expect(opened).toContain("] scroll");
  t.renderer.destroy();
});

test("selection bands mix against the page surface the overlay actually sits on", async () => {
  const band = selectionBg(tokens.bg).toLowerCase();

  const taskView = await mount(PLAN, "understands the reducer");
  const taskSpan = taskView.t
    .captureSpans()
    .lines.flatMap((l) => l.spans)
    .find((s) => s.text.includes("Map cart state"))!;
  expect(rgbToHex(taskSpan.bg).toLowerCase()).toBe(band);
  taskView.t.renderer.destroy();

  const first = document(".clarvis/plans/first.md", "First plan", "completed");
  const plans: PlansService = {
    list: async () => ({ plans: [first] }),
    read: async () => {
      throw new Error("unreadable");
    },
    setRetention: async () => first,
    delete: async (id) => ({ id, deleted: true }),
  };
  const historyView = await mount(null, "First plan", plans);
  const historySpan = historyView.t
    .captureSpans()
    .lines.flatMap((l) => l.spans)
    .find((s) => s.text.includes("First plan"))!;
  expect(rgbToHex(historySpan.bg).toLowerCase()).toBe(band);
  historyView.t.renderer.destroy();
});

test("delete stays disabled for an active plan", async () => {
  const active = document(".clarvis/plans/active.md", "Active plan", "active");
  const deletes: string[] = [];
  const plans: PlansService = {
    list: async () => ({ plans: [active] }),
    read: async () => active,
    setRetention: async () => active,
    delete: async (id) => {
      deletes.push(id);
      return { id, deleted: true };
    },
  };
  const { t, press } = await mount(null, "Active plan", plans);
  press("d");
  press("d");
  await t.renderOnce();
  expect(deletes).toEqual([]);
  t.renderer.destroy();
});
