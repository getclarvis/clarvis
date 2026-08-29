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
import { createSignal } from "solid-js";

type PlanReader = Pick<PlansService, "read">;

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

async function mount(plan: PlanActivity | null, ready?: string, plans?: PlanReader) {
  const { interaction, press } = fakeInteraction();
  const rendered = await openRender(
    (() => <PlanOverlay interaction={interaction} plan={() => plan} plans={plans} />) as never,
    { width: 100, height: 30 },
  );
  await rendered.renderOnce();
  if (ready) await captureUntil(rendered, ready);
  return { t: rendered, press };
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

function livePlan(doc: PlanDocumentDto): PlanActivity {
  return {
    id: doc.id,
    ...(doc.path === undefined ? {} : { path: doc.path }),
    title: doc.title,
    status: doc.status,
    retention: doc.retention,
    revision: doc.revision,
    spec_revision: doc.spec_revision,
    tasks: doc.tasks,
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
  expect(out).toContain("Plan · Running · 1/2 tasks done");
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

test("a returned task auto-selects and shows its result", async () => {
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

test("failed and abandoned tasks show their terminal outcomes", async () => {
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
});

test("progress distinguishes completed tasks from tasks that did not run", async () => {
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

test("pending and in_progress tasks are not counted as settled", async () => {
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

test("the overlay has a current-plan-only empty state", async () => {
  let reads = 0;
  const { t } = await mount(null, "no plan yet", {
    read: async () => {
      reads += 1;
      return document("unused.md", "Historical plan", "completed");
    },
  });
  const out = t.captureCharFrame();
  expect(out).toContain("no plan yet");
  expect(out).not.toContain("history");
  expect(out).not.toContain("keep/delete");
  expect(reads).toBe(0);
  t.renderer.destroy();
});

test("the active plan is read by stable id even when no path exists", async () => {
  const { path: _path, ...base } = document("unused.md", "Remote plan", "active");
  const remote: PlanDocumentDto = { ...base, id: "remote-plan-42" };
  const reads: string[] = [];
  const live = livePlan(remote);
  const { t } = await mount(live, "remote-plan-42", {
    read: async (id) => {
      reads.push(id);
      return remote;
    },
  });
  expect(reads).toEqual(["remote-plan-42"]);
  expect(t.captureCharFrame()).not.toContain("undefined");
  t.renderer.destroy();
});

test("a directly opened plan closes on Escape", async () => {
  const doc = document(PLAN.id, PLAN.title, "awaiting_approval");
  const { interaction, press } = fakeInteraction();
  let closed = 0;
  const t = await openRender(
    (() => (
      <PlanOverlay
        interaction={interaction}
        plan={() => ({ ...PLAN, status: "awaiting_approval" })}
        plans={{ read: async () => doc }}
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
      <PlanOverlay interaction={interaction} plan={() => PLAN} onClose={() => closed++} />
    )) as never,
    { width: 100, height: 30 },
  );
  await t.renderOnce();
  press("ctrl+c");
  expect(closed).toBe(0);
  t.renderer.destroy();
});

test("a mismatched document id is rejected without hiding live tasks", async () => {
  const other = document("other.md", "Another document", "completed");
  const live: PlanActivity = {
    id: "active-elsewhere",
    title: "Active elsewhere",
    status: "active",
    retention: "keep",
    revision: 1,
    spec_revision: 1,
    tasks: [{ id: "t1", title: "Keep working", status: "in_progress" }],
  };
  const { t } = await mount(live, "while reading active plan active-elsewhere", {
    read: async () => other,
  });
  const out = t.captureCharFrame();
  expect(out).toContain("Keep working");
  expect(out).not.toContain("Detail for Another document");
  t.renderer.destroy();
});

test("a stale document response cannot replace a newer live revision", async () => {
  const first: PlanActivity = {
    id: "plan-race",
    title: "First live revision",
    status: "active",
    retention: "keep",
    revision: 1,
    spec_revision: 1,
    tasks: [{ id: "t1", title: "First live task", status: "in_progress" }],
  };
  const second: PlanActivity = {
    ...first,
    title: "Second live revision",
    revision: 2,
    tasks: [{ id: "t2", title: "Second live task", status: "in_progress" }],
  };
  const pending: Array<(doc: PlanDocumentDto) => void> = [];
  const { interaction } = fakeInteraction();
  const [plan, setPlan] = createSignal<PlanActivity | null>(first);
  const t = await openRender(
    (() => (
      <PlanOverlay
        interaction={interaction}
        plan={plan}
        plans={{
          read: async () =>
            await new Promise<PlanDocumentDto>((resolve) => {
              pending.push(resolve);
            }),
        }}
      />
    )) as never,
    { width: 100, height: 30 },
  );

  await captureUntil(t, "First live task");
  expect(pending).toHaveLength(1);
  setPlan(second);
  await captureUntil(t, "Second live task");
  expect(pending).toHaveLength(2);

  pending[1]!({
    ...document("plan-race", "New document", "active"),
    revision: 2,
  });
  expect(await captureUntil(t, "Detail for New document")).toContain("Detail for New document");

  pending[0]!(document("plan-race", "Stale document", "active"));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await t.renderOnce();
  const out = t.captureCharFrame();
  expect(out).toContain("Detail for New document");
  expect(out).not.toContain("Detail for Stale document");
  t.renderer.destroy();
});

test("a reader failure is visible and preserves the live task fallback", async () => {
  const { t } = await mount(PLAN, "provider unavailable", {
    read: async () => {
      throw new Error("provider unavailable");
    },
  });
  const out = t.captureCharFrame();
  expect(out).toContain("plan document invalid: provider unavailable");
  expect(out).toContain("Map cart state");
  t.renderer.destroy();
});

async function approvalFrame(doc: PlanDocumentDto): Promise<string> {
  const { t } = await mount(livePlan(doc), "Detail for " + doc.title, {
    read: async () => doc,
  });
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

test("an unapproved plan names the pending specification revision", async () => {
  const doc = {
    ...document(".clarvis/plans/a.md", "Needs approval", "awaiting_approval"),
    spec_revision: 2,
  };
  const out = await approvalFrame(doc);
  expect(out).toContain("Human approval needed for specification #2");
  expect(out).toContain("Execution update #1 · specification #2");
});

test("an approved plan names the specification the human approved", async () => {
  const doc = {
    ...document(".clarvis/plans/b.md", "Approved plan", "active"),
    spec_revision: 2,
    approved_spec_revision: 2,
  };
  expect(await approvalFrame(doc)).toContain("Human-approved specification #2");
});

test("a structural edit after approval reads as invalidated", async () => {
  const doc = {
    ...document(".clarvis/plans/c.md", "Changed plan", "awaiting_approval"),
    spec_revision: 3,
    approved_spec_revision: 2,
  };
  expect(await approvalFrame(doc)).toContain(
    "specification #3 changed after approval of specification #2",
  );
});

test("a plan that never needed review does not claim an approval", async () => {
  const doc = document(".clarvis/plans/d.md", "Ungated plan", "active");
  expect(await approvalFrame(doc)).toContain("Human review was not required");
});

test("a seeded plan renders readable sections without duplicating live tasks", async () => {
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
  const live: PlanActivity = {
    ...livePlan(doc),
    tasks: [
      { id: "t1", title: "Wire the projection reducer", status: "in_progress" },
      { id: "t2", title: "Render the overlay body", status: "pending" },
    ],
  };
  const { t } = await mount(live, "suite green before release", { read: async () => doc });
  const out = t.captureCharFrame();
  expect(out).toContain("Ship the checkout redesign.");
  expect(out).toContain("Cart flow regressed after the overhaul.");
  expect(out).not.toContain("id: demo");
  expect(out.split("Wire the projection reducer").length - 1).toBe(1);
  t.renderer.destroy();
});

test("a loaded document uses document-scroll mode immediately", async () => {
  const doc: PlanDocumentDto = {
    ...document(".clarvis/plans/demo.md", "Demo overhaul plan", "active"),
    markdown: ["## Objective", "", "Ship it.", "", "## Validation", "", "- green"].join("\n"),
  };
  const { t, press } = await mount(livePlan(doc), "Demo overhaul plan", { read: async () => doc });
  expect(await captureUntil(t, "] scroll")).toContain("] scroll");
  press("down");
  press("pagedown");
  await t.renderOnce();
  t.renderer.destroy();
});

test("task selection bands mix against the page surface", async () => {
  const band = selectionBg(tokens.bg).toLowerCase();
  const { t } = await mount(PLAN, "understands the reducer");
  const taskSpan = t
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.includes("Map cart state"))!;
  expect(rgbToHex(taskSpan.bg).toLowerCase()).toBe(band);
  t.renderer.destroy();
});
