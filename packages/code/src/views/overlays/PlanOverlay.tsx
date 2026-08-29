import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { detachObserved } from "../../core/tasks.ts";
import type { Accessor, JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { PlanDocumentDto, PlansService } from "@clarvis/protocol";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import type { Interaction } from "../../keys/interaction.ts";
import type { PlanActivity, PlanTaskActivity } from "../../adapters/activity-store.ts";
import { planRetentionLabel } from "../../adapters/execution-safety.ts";
import { followSelection } from "../../ui/patterns/list-navigation.ts";
import { LAYER, registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import type { ToneStyle } from "../../theme/tone.ts";
import { taskTone } from "../blocks.tsx";
import { PageFrame } from "../PageFrame.tsx";
import { Prose, stripDocChrome } from "../Prose.tsx";
import { EmptyHint, LoadingHint } from "../config/view-host.tsx";
import { scrollbarOptions, selectionBg, SCROLLBOX_TABLE_GUTTER } from "../../theme/surfaces.ts";
import { lifecycleLabel, uiLifecycle } from "../../ui/presentation.ts";
import { uiCommand } from "../../keys/actions.ts";

/**
 * Separates the human decision over a specification from the operational
 * revision that records task execution. The two counters intentionally never
 * share the ambiguous label "revision" in the UI.
 */
function approvalLine(doc: PlanDocumentDto): string {
  const approved = doc.approved_spec_revision;
  if (doc.status === "awaiting_approval")
    return approved === undefined
      ? `Human approval needed for specification #${doc.spec_revision}`
      : `Human approval needed again: specification #${doc.spec_revision} changed after approval of specification #${approved}`;
  if (approved === undefined) return "Human review was not required";
  return approved === doc.spec_revision
    ? `Human-approved specification #${approved}`
    : `Human approved specification #${approved}; current specification is #${doc.spec_revision}`;
}

/** A concise task outcome that remains accurate for every terminal status. */
function taskProgressLabel(tasks: PlanTaskActivity[]): string {
  const done = tasks.filter((task) => task.status === "done").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const abandoned = tasks.filter((task) => task.status === "abandoned").length;
  const total = tasks.length;
  if (failed > 0 || abandoned > 0) {
    const outcomes = [`${done}/${total} done`];
    if (failed > 0) outcomes.push(`${failed} failed`);
    if (abandoned > 0) outcomes.push(`${abandoned} not run`);
    return outcomes.join(` ${glyph("separator")} `);
  }
  return `${done}/${total} tasks done`;
}

/**
 * Full-screen detail for the current or latest run plan.
 *
 * @remarks
 * The readable document is loaded only by the live plan's stable id. When the
 * backend reader is absent or fails, the live task projection remains usable;
 * no history list, filtering, retention mutation or deletion is exposed here.
 */
export function PlanOverlay(props: {
  interaction: Interaction;
  plan: Accessor<PlanActivity | null>;
  plans?: Pick<PlansService, "read">;
  onClose?: () => void;
  active?: Accessor<boolean>;
}): JSX.Element {
  let scrollEl: ScrollBoxRenderable | undefined;
  const [sel, setSelRaw] = createSignal(0);
  const [document, setDocument] = createSignal<PlanDocumentDto | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [loadingError, setLoadingError] = createSignal("");
  let userNavigated = false;
  let seededRevision = -1;
  let documentRequestSeq = 0;
  let loadedPlanKey = "";

  const activePlan = (): PlanActivity | null => {
    const plan = props.plan();
    return plan && !plan.removed ? plan : null;
  };
  const tasks = (): PlanTaskActivity[] => activePlan()?.tasks ?? [];
  const clamp = (index: number): number => Math.max(0, Math.min(tasks().length - 1, index));
  const setSel = (index: number): void => {
    userNavigated = true;
    setSelRaw(clamp(index));
  };

  async function loadActivePlan(plan: PlanActivity): Promise<void> {
    if (!props.plans) return;
    const seq = ++documentRequestSeq;
    setLoading(true);
    try {
      const doc = await props.plans.read(plan.id);
      if (seq !== documentRequestSeq) return;
      if (doc.id !== plan.id) {
        setLoadingError(`plan service returned ${doc.id} while reading active plan ${plan.id}`);
        return;
      }
      setDocument(doc);
      setLoadingError("");
    } catch (error) {
      if (seq !== documentRequestSeq) return;
      setLoadingError(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === documentRequestSeq) setLoading(false);
    }
  }

  createEffect(
    on(props.plan, (plan) => {
      if (!plan || plan.removed) return;
      if (plan.revision !== seededRevision) {
        seededRevision = plan.revision;
        userNavigated = false;
      }
      if (userNavigated) return;
      const next = ["in_progress", "returned", "pending"]
        .map((status) => tasks().findIndex((task) => task.status === status))
        .find((index) => index >= 0);
      setSelRaw(next ?? 0);
    }),
  );

  createEffect(() => {
    const active = props.active?.() ?? true;
    const plan = activePlan();
    if (!active || !plan) {
      documentRequestSeq += 1;
      loadedPlanKey = "";
      setDocument(null);
      setLoading(false);
      setLoadingError("");
      return;
    }
    const key = `${plan.id}\0${plan.revision}\0${plan.spec_revision}`;
    if (key === loadedPlanKey) return;
    loadedPlanKey = key;
    setDocument(null);
    setLoadingError("");
    if (props.plans) detachObserved("plan_read_active", () => loadActivePlan(plan));
  });

  const scrollMode = createMemo(() => document() !== null);
  const spec = (): LevelSpec => ({
    ...(props.active ? { when: "overlay==plan", enabled: props.active } : {}),
    ...(scrollMode()
      ? { scroll: () => scrollEl }
      : tasks().length > 0
        ? {
            nav: {
              count: () => tasks().length,
              index: sel,
              setIndex: setSel,
              showArrows: true,
            },
          }
        : {}),
  });

  onMount(() => {
    const offEscape = props.interaction.keymap.registerLayer({
      ...(props.active ? { when: "overlay==plan" } : {}),
      ...(props.active ? { enabled: reactiveMatcherFromSignal(props.active) } : {}),
      priority: LAYER.OVERLAY + 1,
      commands: [
        uiCommand({
          id: "plan.escape",
          title: "Close plan",
          description: "Return to the screen that opened this plan",
          category: "escape",
          surfaces: ["footer"],
          footerLabel: "close",
          hintPriority: 100,
          hintGroup: "escape",
          essential: true,
          enabled: () => !!props.onClose,
          run: () => props.onClose?.(),
        }),
        uiCommand({
          id: "plan.close",
          title: "Close plan",
          description: "Close the plan screen without cancelling the run",
          category: "escape",
          surfaces: ["full-help"],
          enabled: () => !!props.onClose,
          run: () => props.onClose?.(),
        }),
      ],
      bindings: [
        { key: "escape", cmd: "plan.escape" },
        { key: "ctrl+p", cmd: "plan.escape" },
      ],
    });
    onCleanup(offEscape);
  });
  createEffect(() => {
    const off = registerLevel(props.interaction.keymap, spec(), LAYER.OVERLAY);
    onCleanup(off);
  });
  followSelection(
    () => scrollEl,
    "plan-",
    () => clamp(sel()),
  );

  const title = (): string => {
    const doc = document();
    if (doc) return `Plan ${glyph("chevronRight")} ${doc.title}`;
    const plan = activePlan();
    if (!plan) return "Plan";
    const progress =
      plan.status === "awaiting_approval"
        ? `${plan.tasks.length} ${plan.tasks.length === 1 ? "task" : "tasks"} proposed`
        : taskProgressLabel(plan.tasks);
    return `Plan ${glyph("separator")} ${lifecycleLabel(uiLifecycle(plan.status))} ${glyph("separator")} ${progress}`;
  };

  function outcomeLine(label: string, content: string, fg: string): JSX.Element {
    return (
      <box flexDirection="row" paddingLeft={4}>
        <text fg={tokens.muted} flexShrink={0}>
          {label + " "}
        </text>
        <Prose content={content} fg={fg} />
      </box>
    );
  }

  function taskRow(plan: PlanActivity, index: number): JSX.Element {
    const task = (): PlanTaskActivity => plan.tasks[index]!;
    const tone = (): ToneStyle => taskTone(task().status);
    const selected = (): boolean => clamp(sel()) === index;
    const hasCurrentTask = (): boolean =>
      plan.status === "active" || plan.status === "awaiting_approval" || userNavigated;
    return (
      <box flexDirection="column" paddingLeft={1}>
        <box
          flexDirection="row"
          width="100%"
          id={`plan-${index}`}
          backgroundColor={selected() ? selectionBg(tokens.bg) : undefined}
        >
          <text fg={hasCurrentTask() && selected() ? tokens.accent : tokens.muted} flexShrink={0}>
            {hasCurrentTask() && selected() ? glyph("chevronRight") + " " : "  "}
          </text>
          <text fg={tone().fg} flexShrink={0}>
            {tone().glyph + " "}
          </text>
          <text
            fg={selected() ? tokens.fg : task().status === "in_progress" ? tokens.fg : tokens.muted}
            wrapMode="word"
            flexGrow={1}
            flexBasis={0}
            minWidth={0}
          >
            {task().title + (task().assignee ? `  ${glyph("separator")} ${task().assignee}` : "")}
          </text>
        </box>
        <Show when={selected() && task().description}>
          <box flexDirection="row" paddingLeft={4}>
            <Prose content={task().description ?? ""} fg={tokens.muted} />
          </box>
        </Show>
        <Show when={selected() && task().exit_condition}>
          <box flexDirection="row" paddingLeft={4}>
            <text fg={tokens.muted} flexShrink={0}>
              {glyph("arrowRight") + " "}
            </text>
            <Prose content={task().exit_condition ?? ""} fg={tokens.muted} />
          </box>
        </Show>
        <Show when={selected() && task().result}>
          {outcomeLine("result", task().result ?? "", tokens.fg)}
        </Show>
        <Show when={selected() && task().error}>
          {outcomeLine("error", task().error ?? "", tokens.del)}
        </Show>
        <Show when={selected() && task().reason}>
          {outcomeLine("reason", task().reason ?? "", tokens.muted)}
        </Show>
      </box>
    );
  }

  return (
    <PageFrame title={title()} interaction={props.interaction}>
      <scrollbox
        ref={(element: ScrollBoxRenderable) => (scrollEl = element)}
        flexGrow={1}
        paddingRight={SCROLLBOX_TABLE_GUTTER}
        verticalScrollbarOptions={scrollbarOptions()}
      >
        <Show
          when={activePlan()}
          fallback={
            <EmptyHint
              text="no plan yet"
              icon="info"
              hint="start a task with planning enabled; its current plan appears here"
            />
          }
        >
          {(plan: Accessor<PlanActivity>) => (
            <box flexDirection="column">
              <Show when={document()}>
                {(doc: Accessor<PlanDocumentDto>) => (
                  <box flexDirection="column" paddingBottom={1}>
                    <text fg={tokens.muted} wrapMode="word">
                      {`${lifecycleLabel(uiLifecycle(doc().status))} ${glyph("separator")} ${taskProgressLabel(doc().tasks)} ${glyph("separator")} ${planRetentionLabel(doc().retention)}`}
                    </text>
                    <text
                      fg={doc().status === "awaiting_approval" ? tokens.accent : tokens.muted}
                      wrapMode="word"
                    >
                      {approvalLine(doc())}
                    </text>
                    <text fg={tokens.muted} wrapMode="word">
                      {`Execution update #${doc().revision} ${glyph("separator")} specification #${doc().spec_revision}`}
                    </text>
                    <text fg={tokens.muted} wrapMode="word">
                      {doc().path ?? doc().id}
                    </text>
                    <Prose block content={stripDocChrome(doc().markdown)} />
                  </box>
                )}
              </Show>
              <Show when={loadingError()}>
                <box flexDirection="column" paddingBottom={1}>
                  <text fg={tokens.del} wrapMode="word">
                    {`plan document invalid: ${loadingError()}`}
                  </text>
                </box>
              </Show>
              <Show when={plan().reviewOutcome}>
                <text fg={tokens.muted} wrapMode="word">
                  {glyph("separator") + " review: " + plan().reviewOutcome}
                </text>
              </Show>
              <Show when={!document()}>
                <For each={tasks()}>{(_, index) => taskRow(plan(), index())}</For>
              </Show>
              <Show when={loading() && !document() && tasks().length === 0}>
                <LoadingHint text="loading plan detail" />
              </Show>
            </box>
          )}
        </Show>
      </scrollbox>
    </PageFrame>
  );
}
