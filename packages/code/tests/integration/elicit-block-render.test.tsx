import { expect, test } from "bun:test";
import { createSignal, Show } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import type { ElicitRequestParams, ElicitResult } from "../../src/adapters/elicit-types.ts";
import { ElicitBlock } from "../../src/views/ElicitBlock.tsx";
import { BlockView } from "../../src/views/blocks.tsx";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import type { PlanActivity } from "../../src/adapters/plan-projection.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const stubInteraction = {
  keymap: createFakeKeymap().keymap,
} as unknown as Interaction;

function fakeInteraction(): { interaction: Interaction; press: (key: string) => void } {
  const { keymap, press } = createFakeKeymap();
  return { interaction: { keymap } as unknown as Interaction, press };
}

const PLAN_REVIEW: ElicitRequestParams = {
  message: "Approve the plan, request changes, or cancel?",
  requestedSchema: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["approve", "request_changes", "cancel"] },
      feedback: { type: "string", description: "Optional notes." },
    },
    required: ["decision"],
  },
};

const asPlanReview = (request: ElicitRequestParams = PLAN_REVIEW): ElicitRequestParams => ({
  ...request,
  kind: "plan_review",
});

async function frame(ui: () => unknown): Promise<string> {
  const t = await openRender(ui as never, { width: 100, height: 40 });
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

test("ElicitBlock renders the question, options and footer inline", async () => {
  const out = await frame(() => (
    <ElicitBlock interaction={stubInteraction} request={PLAN_REVIEW} onResolve={() => {}} />
  ));
  expect(out).toContain("Agent asks");
  expect(out).toContain("Approve the plan");
  expect(out).toContain("approve");
  expect(out).toContain("request_changes");
});

test("an iteration-limit question omits soft wording in the TUI", async () => {
  const out = await frame(() => (
    <ElicitBlock
      interaction={stubInteraction}
      request={{
        message: "Used 200 of the soft iterations limit (200). Continue?",
        requestedSchema: {
          type: "object",
          properties: {
            continue: {
              type: "string",
              enum: ["continue", "stop"],
              description: "Continue past the soft limit, or stop with the partial result?",
            },
          },
          required: ["continue"],
        },
      }}
      onResolve={() => {}}
    />
  ));
  expect(out).toContain("Used 200 of the iteration limit (200). Continue?");
  expect(out).toContain("Continue past the iteration limit");
  expect(out).not.toContain("soft");
});

const PLAN_ACTIVITY: PlanActivity = {
  id: ".clarvis/plans/search.md",
  path: ".clarvis/plans/search.md",
  title: "Implement session search",
  status: "awaiting_approval",
  retention: "keep",
  revision: 4,
  spec_revision: 2,
  tasks: [
    { id: "t1", title: "One", status: "pending" },
    { id: "t2", title: "Two", status: "pending" },
  ],
};

test("a plan_review is framed as an approval gate, not as an agent question", async () => {
  const out = await frame(() => (
    <ElicitBlock
      interaction={stubInteraction}
      request={{ ...PLAN_REVIEW, kind: "plan_review" }}
      onResolve={() => {}}
      plan={() => PLAN_ACTIVITY}
      onOpenPlan={() => {}}
    />
  ));
  expect(out).toContain("Plan approval required");
  expect(out).not.toContain("Agent asks");
  expect(out).toContain("Implement session search");
  expect(out).toContain("revision 2");
  expect(out).toContain("2 tasks");
  expect(out).toContain("retention: keep");
  expect(out).toContain("request changes");
  expect(out).not.toContain("request_changes");
});

test("a plan_review without a plan projection still renders the gate", async () => {
  const out = await frame(() => (
    <ElicitBlock
      interaction={stubInteraction}
      request={{ ...PLAN_REVIEW, kind: "plan_review" }}
      onResolve={() => {}}
      plan={() => null}
    />
  ));
  expect(out).toContain("Plan approval required");
  expect(out).toContain("request changes");
  expect(out).not.toContain("[Ctrl+P] open plan");
});

const WORKFLOW_REVIEW: ElicitRequestParams = {
  kind: "workflow_review",
  message:
    "Workflow: exhaustive-review\nRounds: discover → inspect → verify\nEstimated leaders: 6\n\nNo leader has been launched yet.",
  requestedSchema: {
    type: "object",
    properties: { decision: { type: "string", enum: ["cancel", "run"] } },
    required: ["decision"],
  },
};

const EXECUTION_APPROVAL: ElicitRequestParams = {
  kind: "execution_approval",
  message:
    "Tool: shell\nCommand: curl example.com\nPermissions: network enabled\nReason: network request",
  requestedSchema: {
    type: "object",
    properties: { approved: { type: "string", enum: ["yes", "no"] } },
    required: ["approved"],
  },
};

test("execution approval displays the action and requires an explicit choice", async () => {
  const approval = await mountKeyed(EXECUTION_APPROVAL);
  expect(approval.t.captureCharFrame()).toContain("Execution approval required");
  expect(approval.t.captureCharFrame()).toContain("network enabled");
  approval.press("return");
  expect(approval.resolved).toEqual([]);
  approval.press("1");
  expect(approval.resolved).toEqual([{ action: "accept", content: { approved: "yes" } }]);
  approval.t.renderer.destroy();
});

test("a workflow_review is an explicit preflight with a safe before-start promise", async () => {
  const out = await frame(() => (
    <ElicitBlock interaction={stubInteraction} request={WORKFLOW_REVIEW} onResolve={() => {}} />
  ));
  expect(out).toContain("Workflow approval required");
  expect(out).not.toContain("Agent asks");
  expect(out).toContain("Rounds: discover");
  expect(out).toContain("No leader has been launched yet");
  expect(out).toContain("[1] run workflow");
  expect(out).toContain("[2] do not run");
});

test("workflow preflight has no default and a numbered decision submits immediately", async () => {
  const run = await mountKeyed(WORKFLOW_REVIEW);
  run.press("return");
  expect(run.resolved).toEqual([]);
  expect(run.notices).toEqual(["answer required: decision"]);
  run.press("1");
  expect(run.resolved).toEqual([{ action: "accept", content: { decision: "run" } }]);
  run.t.renderer.destroy();

  const cancel = await mountKeyed(WORKFLOW_REVIEW);
  cancel.press("2");
  expect(cancel.resolved).toEqual([{ action: "accept", content: { decision: "cancel" } }]);
  cancel.t.renderer.destroy();
});

test("Ctrl+P opens the plan overlay from the approval gate", async () => {
  const { interaction, press } = fakeInteraction();
  let opened = 0;
  const t = await openRender(
    (() => (
      <ElicitBlock
        interaction={interaction}
        request={{ ...PLAN_REVIEW, kind: "plan_review" }}
        onResolve={() => {}}
        plan={() => PLAN_ACTIVITY}
        onOpenPlan={() => opened++}
      />
    )) as never,
    { width: 100, height: 40 },
  );
  await t.renderOnce();
  press("<leader>p");
  expect(opened).toBe(1);
  t.renderer.destroy();
});

async function mountKeyed(request: ElicitRequestParams): Promise<{
  t: Awaited<ReturnType<typeof openRender>>;
  press: (key: string) => void;
  resolved: ElicitResult[];
  notices: string[];
}> {
  const { interaction, press } = fakeInteraction();
  const resolved: ElicitResult[] = [];
  const notices: string[] = [];
  const t = await openRender(
    (() => (
      <ElicitBlock
        interaction={interaction}
        request={request}
        onResolve={(r) => resolved.push(r)}
        onNotify={(message) => notices.push(message)}
      />
    )) as never,
    { width: 100, height: 40 },
  );
  await t.renderOnce();
  return { t, press, resolved, notices };
}

test("plan review has no preselected verdict and a digit submits its decision immediately", async () => {
  const { t, press, resolved, notices } = await mountKeyed(asPlanReview());
  const initial = t.captureCharFrame();
  expect(initial).not.toContain("(◉)");

  press("return");
  expect(resolved).toEqual([]);
  expect(notices).toEqual(["answer required: decision"]);

  press("2");
  expect(resolved).toEqual([{ action: "accept", content: { decision: "request_changes" } }]);
  t.renderer.destroy();
});

test("modal choice bindings consume digit shortcuts instead of passing them to an input", async () => {
  const { keymap, layers } = createFakeKeymap();
  const t = await openRender(
    (() => (
      <ElicitBlock
        interaction={{ keymap } as Interaction}
        request={asPlanReview()}
        onResolve={() => {}}
      />
    )) as never,
    { width: 100, height: 40 },
  );
  await t.renderOnce();
  const bindings = layers.flatMap((layer) => layer.bindings ?? []);
  for (const key of ["1", "2", "3", "0", "up", "down"]) {
    const binding = bindings.find((candidate) => candidate.key === key);
    expect(binding, `${key} is owned by the modal layer`).toBeDefined();
    expect(binding?.preventDefault, `${key} must not reach a focused composer`).not.toBe(false);
  }
  t.renderer.destroy();
});

test("select follows the picker grammar: down moves the highlight, enter commits it", async () => {
  const { t, press, resolved } = await mountKeyed(PLAN_REVIEW);
  press("down");
  expect(resolved).toEqual([]);
  press("return");
  expect(resolved).toEqual([{ action: "accept", content: { decision: "request_changes" } }]);
  t.renderer.destroy();
});

test("a digit shortcut submits immediately", async () => {
  const { t, press, resolved } = await mountKeyed(PLAN_REVIEW);
  press("3");
  expect(resolved).toEqual([{ action: "accept", content: { decision: "cancel" } }]);
  t.renderer.destroy();
});

test("zero submits the tenth numbered option", async () => {
  const options = Array.from({ length: 10 }, (_, index) => `option-${index + 1}`);
  const request: ElicitRequestParams = {
    message: "Choose one",
    requestedSchema: {
      type: "object",
      properties: { response: { type: "string", enum: options } },
      required: ["response"],
    },
  };
  const { t, press, resolved } = await mountKeyed(request);
  expect(t.captureCharFrame()).toContain("[0] option-10");
  press("0");
  expect(resolved).toEqual([{ action: "accept", content: { response: "option-10" } }]);
  t.renderer.destroy();
});

test("numbered-choice commands deactivate while a text field is active", async () => {
  const { t, press, resolved } = await mountKeyed(PLAN_REVIEW);
  press("tab");
  press("2");
  press("return");
  expect(resolved).toEqual([{ action: "accept", content: { decision: "approve" } }]);
  t.renderer.destroy();
});

test("the prior model message stays visible ABOVE the inline elicitation (the core fix)", async () => {
  const prior: TranscriptNode = {
    key: "m0",
    kind: "user",
    status: "ok",
    text: "PRIOR MESSAGE that prompted the question",
  };
  const out = await frame(() => (
    <box flexDirection="column">
      <BlockView node={prior} />
      <ElicitBlock interaction={stubInteraction} request={PLAN_REVIEW} onResolve={() => {}} />
    </box>
  ));
  expect(out).toContain("PRIOR MESSAGE");
  expect(out).toContain("Agent asks");
});

const SECOND_QUESTION: ElicitRequestParams = {
  message: "SECOND QUESTION replacing the first",
  requestedSchema: {
    type: "object",
    properties: { go: { type: "string", enum: ["yes", "no"] } },
    required: ["go"],
  },
};

test("a superseding request REMOUNTS the form (the App's keyed <Show> pattern)", async () => {
  const [req, setReq] = createSignal<ElicitRequestParams | null>(PLAN_REVIEW);
  const t = await openRender(
    (() => (
      <Show when={req()} keyed>
        {(r: ElicitRequestParams) => (
          <ElicitBlock interaction={stubInteraction} request={r} onResolve={() => {}} />
        )}
      </Show>
    )) as never,
    { width: 100, height: 40 },
  );
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Approve the plan");

  setReq(SECOND_QUESTION);
  await t.renderOnce();
  const out = t.captureCharFrame();
  expect(out).toContain("SECOND QUESTION");
  expect(out).not.toContain("Approve the plan");
  t.renderer.destroy();
});

test("an elicitation can fill the transcript side of a split layout", async () => {
  const t = await openRender(
    (() => (
      <ElicitBlock
        interaction={stubInteraction}
        request={PLAN_REVIEW}
        onResolve={() => {}}
        fillAvailableWidth={() => true}
      />
    )) as never,
    { width: 160, height: 40 },
  );
  await t.renderOnce();
  const border = t
    .captureCharFrame()
    .split("\n")
    .find((row) => row.includes("╭") && row.includes("╮"));
  t.renderer.destroy();

  expect(border).toBeDefined();
  expect(border!.indexOf("╮")).toBe(159);
});

const ASK_USER: ElicitRequestParams = {
  message: "Which deploy target?",
  kind: "ask_user",
  id: "q1",
  windowMs: 30_000,
  requestedSchema: {
    type: "object",
    properties: { target: { type: "string", enum: ["staging-box", "production-box"] } },
    required: ["target"],
  },
};

test("a windowed question counts the kernel's projection down on screen", async () => {
  const out = await frame(() => (
    <ElicitBlock
      interaction={stubInteraction}
      request={ASK_USER}
      remaining={() => 17_500}
      onResolve={() => {}}
    />
  ));
  expect(out).toContain("The model decides in 18 s.");
  expect(out).toContain("staging-box");
});

test("a question with no projection renders no countdown instead of a declared one", async () => {
  const waiting = await frame(() => (
    <ElicitBlock
      interaction={stubInteraction}
      request={ASK_USER}
      remaining={() => null}
      onResolve={() => {}}
    />
  ));
  expect(waiting).not.toContain("The model decides");
  expect(waiting).not.toContain("No response in time");
  expect(waiting).toContain("staging-box");

  const unwired = await frame(() => (
    <ElicitBlock interaction={stubInteraction} request={ASK_USER} onResolve={() => {}} />
  ));
  expect(unwired).not.toContain("The model decides");
  expect(unwired).toContain("staging-box");
});

test("an elapsed window stops offering the controls and returns the decision", async () => {
  const out = await frame(() => (
    <ElicitBlock
      interaction={stubInteraction}
      request={ASK_USER}
      remaining={() => 0}
      onResolve={() => {}}
    />
  ));
  expect(out).toContain("No response in time; decision returned to the model.");
  expect(out).not.toContain("staging-box");
  expect(out).not.toContain("production-box");
});
