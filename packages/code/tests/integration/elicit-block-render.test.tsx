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
  expect(out).not.toContain("[^p] open plan");
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

test("a workflow_review is an explicit preflight with a safe before-start promise", async () => {
  const out = await frame(() => (
    <ElicitBlock interaction={stubInteraction} request={WORKFLOW_REVIEW} onResolve={() => {}} />
  ));
  expect(out).toContain("Workflow approval required");
  expect(out).not.toContain("Agent asks");
  expect(out).toContain("Rounds: discover");
  expect(out).toContain("No leader has been launched yet");
  expect(out).toContain("run workflow");
  expect(out).toContain("do not run");
});

test("workflow preflight has no default and submits only an explicitly highlighted decision", async () => {
  const run = await mountKeyed(WORKFLOW_REVIEW);
  run.press("return");
  expect(run.resolved).toEqual([]);
  expect(run.notices).toEqual(["answer required: decision"]);
  run.press("2");
  run.press("return");
  expect(run.resolved).toEqual([{ action: "accept", content: { decision: "run" } }]);
  run.t.renderer.destroy();

  const cancel = await mountKeyed(WORKFLOW_REVIEW);
  cancel.press("1");
  cancel.press("return");
  expect(cancel.resolved).toEqual([{ action: "accept", content: { decision: "cancel" } }]);
  cancel.t.renderer.destroy();
});

test("^p opens the plan overlay from the approval gate", async () => {
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
  press("ctrl+p");
  expect(opened).toBe(1);
  t.renderer.destroy();
});

const GUARD_CONFIRM: ElicitRequestParams = {
  message: "no allowed commands list configured\n\n$ rm -rf build",
  kind: "guard_confirm",
  requestedSchema: {
    type: "object",
    properties: { decision: { type: "string", enum: ["deny", "allow"] } },
    required: ["decision"],
  },
};

test("a guard confirmation is framed as a command approval, not a neutral question", async () => {
  const out = await frame(() => (
    <ElicitBlock interaction={stubInteraction} request={GUARD_CONFIRM} onResolve={() => {}} />
  ));
  expect(out).toContain("Command approval");
  expect(out).not.toContain("Agent asks");
  expect(out).toContain("no allowed commands list configured");
  expect(out).toContain("rm -rf build");
  expect(out).toMatch(/\(◉\)\s+\[1\]\s+deny/);
  expect(out).toMatch(/\[2\]\s+allow once/);
});

const GUARD_SESSION: ElicitRequestParams = {
  message: "no allowed commands list configured\n\n$ bun test tests/plan.test.ts",
  kind: "guard_confirm",
  detail: {
    command: "bun test tests/plan.test.ts",
    cwd: "/work/repo",
    reason: "no allowed commands list configured",
  },
  requestedSchema: {
    type: "object",
    properties: { decision: { type: "string", enum: ["deny", "allow", "allow_session"] } },
    required: ["decision"],
  },
};

test("a structured guard shows the reason and the command as code with its cwd", async () => {
  const out = await frame(() => (
    <ElicitBlock interaction={stubInteraction} request={GUARD_SESSION} onResolve={() => {}} />
  ));
  expect(out).toContain("no allowed commands list configured");
  expect(out).toContain("bun test tests/plan.test.ts");
  expect(out).toContain("in /work/repo");
  expect(out).not.toContain("$ bun test");
});

test("a structured guard surfaces the analyzer's undecidable-expansions warning", async () => {
  const undecidable: ElicitRequestParams = {
    ...GUARD_SESSION,
    detail: {
      command: "echo $(whoami)",
      cwd: "/work/repo",
      reason: "command contains dynamic expansions that cannot be analyzed",
      warning: "Warning: this command contains undecidable expansions.",
    },
    requestedSchema: {
      type: "object",
      properties: { decision: { type: "string", enum: ["deny", "allow"] } },
      required: ["decision"],
    },
  };
  const out = await frame(() => (
    <ElicitBlock interaction={stubInteraction} request={undecidable} onResolve={() => {}} />
  ));
  expect(out).toContain("Warning: this command contains undecidable expansions.");
});

test("allow_session carries an explicit scope label and never takes the default focus", async () => {
  const out = await frame(() => (
    <ElicitBlock interaction={stubInteraction} request={GUARD_SESSION} onResolve={() => {}} />
  ));
  expect(out).toMatch(/\(◉\)\s+\[1\]\s+deny/);
  expect(out).toMatch(/\[2\]\s+allow once/);
  expect(out).toMatch(/\[3\]\s+allow for this session/);

  const untouched = await mountKeyed(GUARD_SESSION);
  untouched.press("return");
  expect(untouched.resolved).toEqual([{ action: "accept", content: { decision: "deny" } }]);
  untouched.t.renderer.destroy();

  const session = await mountKeyed(GUARD_SESSION);
  session.press("3");
  session.press("return");
  expect(session.resolved).toEqual([{ action: "accept", content: { decision: "allow_session" } }]);
  session.t.renderer.destroy();
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

test("plan review has no preselected verdict: select first, then confirm", async () => {
  const { t, press, resolved, notices } = await mountKeyed(asPlanReview());
  const initial = t.captureCharFrame();
  expect(initial).not.toContain("(◉)");

  press("return");
  expect(resolved).toEqual([]);
  expect(notices).toEqual(["answer required: decision"]);

  press("2");
  await t.renderOnce();
  const selected = t.captureCharFrame();
  // Cursor and radio move together in the same render, before confirmation.
  expect(selected).toMatch(/▸\s+\(◉\)\s+\[2\]\s+request changes/);

  press("return");
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
  for (const key of ["1", "2", "3", "up", "down"]) {
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

test("a digit shortcut jumps the highlight but only enter submits", async () => {
  const { t, press, resolved } = await mountKeyed(PLAN_REVIEW);
  press("3");
  expect(resolved).toEqual([]);
  press("return");
  expect(resolved).toEqual([{ action: "accept", content: { decision: "cancel" } }]);
  t.renderer.destroy();
});

test("digits are ignored while a text field is active (never stolen from inputs)", async () => {
  const { t, press, resolved } = await mountKeyed(PLAN_REVIEW);
  press("tab");
  press("2");
  press("return");
  expect(resolved).toEqual([{ action: "accept", content: { decision: "approve" } }]);
  t.renderer.destroy();
});

test("guard: an arrow never silently flips allow/deny — escape still denies", async () => {
  const { t, press, resolved } = await mountKeyed(GUARD_CONFIRM);
  press("down");
  press("escape");
  expect(resolved).toEqual([{ action: "cancel" }]);
  t.renderer.destroy();
});

test("guard: enter commits exactly the highlighted option", async () => {
  const first = await mountKeyed(GUARD_CONFIRM);
  first.press("return");
  expect(first.resolved).toEqual([{ action: "accept", content: { decision: "deny" } }]);
  first.t.renderer.destroy();

  const second = await mountKeyed(GUARD_CONFIRM);
  second.press("down");
  second.press("return");
  expect(second.resolved).toEqual([{ action: "accept", content: { decision: "allow" } }]);
  second.t.renderer.destroy();
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

const LONG_TAIL = "&& touch DANGER_MARKER_THE_USER_MUST_SEE.txt";
const LONG_COMMAND = `git log --oneline --decorate --graph --all --abbrev-commit --no-merges --first-parent -n 1 ${LONG_TAIL}`;

const GUARD_LONG: ElicitRequestParams = {
  message: `command not in the allowed commands list\n\n$ ${LONG_COMMAND}`,
  kind: "guard_confirm",
  detail: {
    command: LONG_COMMAND,
    cwd: "/work/repo",
    reason: "command not in the allowed commands list",
  },
  requestedSchema: {
    type: "object",
    properties: { decision: { type: "string", enum: ["deny", "allow", "allow_session"] } },
    required: ["decision"],
  },
};

test("a command wider than the frame is shown whole, never clipped at the border", async () => {
  const out = await frame(() => (
    <ElicitBlock interaction={stubInteraction} request={GUARD_LONG} onResolve={() => {}} />
  ));
  // The tail is what decides the approval. Clipped, `&& touch DANGER…` and
  // `&& rm -rf ~` are the same screen.
  expect(out).toContain("DANGER_MARKER_THE_USER_MUST_SEE.txt");
  expect(out).toContain("command not in the allowed commands list");
  expect(out).toContain("in /work/repo");
});

test("the decision rows survive a command that wraps over several lines", async () => {
  const out = await frame(() => (
    <ElicitBlock interaction={stubInteraction} request={GUARD_LONG} onResolve={() => {}} />
  ));
  expect(out).toContain("deny");
  expect(out).toContain("allow once");
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
