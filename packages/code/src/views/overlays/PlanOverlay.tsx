import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { detachObserved } from "../../core/tasks.ts";
import type { Accessor, JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { PlanDocumentDto, PlansService } from "@clarvis/protocol";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import type { Interaction } from "../../keys/interaction.ts";
import type { PlanActivity, PlanTaskActivity } from "../../adapters/activity-store.ts";
import { followSelection } from "../../ui/patterns/list-navigation.ts";
import { LAYER, registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import type { ToneStyle } from "../../theme/tone.ts";
import { taskTone } from "../blocks.tsx";
import { PageFrame } from "../PageFrame.tsx";
import { Prose } from "../Prose.tsx";
import { EmptyHint, LoadingHint } from "../config/view-host.tsx";
import { scrollbarOptions, selectionBg, SCROLLBOX_TABLE_GUTTER } from "../../theme/surfaces.ts";
import { lifecycleLabel, uiLifecycle } from "../../ui/presentation.ts";
import {
  detailCloseActions,
  DetailColumn,
  DetailTitle,
  DetailHeading,
  detailStatusColor,
} from "../../ui/patterns/detail-view.tsx";

/** Surface pending approval without exposing persistence revisions or routine review metadata. */
function approvalLine(doc: PlanDocumentDto): string | undefined {
  if (doc.status !== "awaiting_approval") return undefined;
  return doc.approved_spec_revision === undefined
    ? "Approval needed before work can continue."
    : "The plan changed. Review it again before work continues.";
}

/** A readable section omits absent content instead of showing empty document fields. */
function detailSection(label: string, content: string, fg = tokens.fg): JSX.Element {
  return (
    <Show when={content.trim()}>
      <box flexDirection="column">
        <DetailHeading>{label}</DetailHeading>
        <Prose block content={content} fg={fg} />
      </box>
    </Show>
  );
}

/** Render the provider's structured plan using the same bounded reading column as Goal. */
function PlanDetail(props: { document: PlanDocumentDto }): JSX.Element {
  const doc = () => props.document;
  return (
    <DetailColumn>
      <DetailTitle>{doc().title}</DetailTitle>
      <text marginTop={1} fg={detailStatusColor(uiLifecycle(doc().status))} wrapMode="word">
        {`${lifecycleLabel(uiLifecycle(doc().status))} ${glyph("separator")} ${taskProgressLabel(doc().tasks)}`}
      </text>
      <Show when={approvalLine(doc())}>
        <text marginTop={1} fg={tokens.warn} wrapMode="word">
          {approvalLine(doc())}
        </text>
      </Show>
      <Show when={doc().objective.trim() !== doc().title.trim()}>
        {detailSection("Objective", doc().objective)}
      </Show>
      {detailSection("Context", doc().context)}
      <Show when={doc().tasks.length > 0}>
        <DetailHeading>Tasks</DetailHeading>
        <For each={doc().tasks}>
          {(task) => (
            <box flexDirection="column" marginTop={1}>
              <text fg={detailStatusColor(uiLifecycle(task.status))} wrapMode="word">
                {`${taskTone(task.status).glyph} ${task.title}`}
              </text>
              <box flexDirection="column" paddingLeft={2}>
                <Show when={task.detail?.trim()}>
                  <Prose block content={task.detail!} fg={tokens.muted} />
                </Show>
                <Show when={task.exit?.trim()}>
                  <Prose block content={`Done when: ${task.exit}`} fg={tokens.muted} />
                </Show>
                <Show when={task.result?.trim()}>
                  <Prose block content={task.result!} />
                </Show>
                <Show when={task.error?.trim()}>
                  <Prose block content={task.error!} fg={tokens.del} />
                </Show>
                <Show when={task.reason?.trim()}>
                  <Prose block content={task.reason!} fg={tokens.muted} />
                </Show>
              </box>
            </box>
          )}
        </For>
      </Show>
      <Show when={doc().validation.some((item) => item.trim())}>
        <DetailHeading>Validation</DetailHeading>
        <For each={doc().validation.filter((item) => item.trim())}>
          {(item) => <Prose block content={`- ${item}`} />}
        </For>
      </Show>
      {detailSection("Notes", doc().notes)}
      <For each={Object.entries(doc().extra_sections)}>
        {([heading, content]) => detailSection(heading, content)}
      </For>
    </DetailColumn>
  );
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
    ...(props.onClose ? detailCloseActions("<leader>p", props.onClose) : {}),
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
    if (doc) return "Plan";
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
    <PageFrame
      title={title()}
      interaction={props.interaction}
      actionFilter={(action) => action.id !== "run.cancel"}
    >
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
                {(doc: Accessor<PlanDocumentDto>) => <PlanDetail document={doc()} />}
              </Show>
              <Show when={loadingError()}>
                <box flexDirection="column" paddingBottom={1}>
                  <text fg={tokens.del} wrapMode="word">
                    {`plan document invalid: ${loadingError()}`}
                  </text>
                </box>
              </Show>
              <Show
                when={!document() && plan().reviewOutcome && plan().reviewOutcome !== "approved"}
              >
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
