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
import type { PlanDocumentDto, PlanRetention, PlansService, PlanStatus } from "@clarvis/protocol";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import type { Interaction } from "../../keys/interaction.ts";
import type { PlanActivity, PlanTaskActivity } from "../../adapters/activity-store.ts";
import { planHistoryLabel } from "../../adapters/execution-safety.ts";
import { followSelection } from "../../ui/patterns/list-navigation.ts";
import { LAYER, registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import type { ToneStyle } from "../../theme/tone.ts";
import { taskTone } from "../blocks.tsx";
import { useArmedConfirm } from "../confirm.ts";
import { PageFrame } from "../PageFrame.tsx";
import { Prose, stripDocChrome } from "../Prose.tsx";
import { EmptyHint, LoadingHint } from "../config/view-host.tsx";
import { PickerRow } from "./PickerRow.tsx";
import { scrollbarOptions, selectionBg, SCROLLBOX_TABLE_GUTTER } from "../../theme/surfaces.ts";
import { lifecycleLabel, uiLifecycle } from "../../ui/presentation.ts";
import { uiCommand } from "../../keys/actions.ts";

type PlanFocus = "history" | "tasks";

const PAGE_SIZE = 8;
const STATUS_COL_WIDTH = 17;
const RETENTION_COL_WIDTH = 7;
const STATUS_FILTERS: (PlanStatus | undefined)[] = [
  undefined,
  "active",
  "awaiting_approval",
  "completed",
  "cancelled",
  "failed",
];
const RETENTION_FILTERS: (PlanRetention | undefined)[] = [undefined, "keep", "discard"];

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
 * The full-screen plan overlay: a paginated, filterable history list (when a
 * {@link PlansService} is available) alongside the selected plan's readable
 * document and task list.
 *
 * @remarks
 * The readable plan (Objective/Context/Tasks/Validation) renders from the
 * markdown body whenever a document is available; the interactive task-row
 * projection is only the fallback for when no document can be read (no
 * `PlansService`, or a provider read that failed). Gating that fallback on
 * `!document()` keeps the two views from painting the tasks twice.
 */
export function PlanOverlay(props: {
  interaction: Interaction;
  plan: Accessor<PlanActivity | null>;
  plans?: PlansService;
  notify?: (message: string, tone?: "success" | "warn" | "error") => void;
  onClose?: () => void;
  /** Where this overlay was opened from; only history-origin detail navigates back to history. */
  origin?: "direct" | "history";
  active?: Accessor<boolean>;
}): JSX.Element {
  let scrollEl: ScrollBoxRenderable | undefined;
  const [sel, setSelRaw] = createSignal(0);
  const [document, setDocument] = createSignal<PlanDocumentDto | null>(null);
  const [history, setHistory] = createSignal<PlanDocumentDto[]>([]);
  const [historySel, setHistorySel] = createSignal(0);
  const activePlan = (): PlanActivity | null => {
    const plan = props.plan();
    return plan && !plan.removed ? plan : null;
  };
  const [focus, setFocus] = createSignal<PlanFocus>(
    props.origin === "history" && props.plans
      ? "history"
      : activePlan() || !props.plans
        ? "tasks"
        : "history",
  );
  const [nextCursor, setNextCursor] = createSignal<string>();
  const [cursorStack, setCursorStack] = createSignal<(string | undefined)[]>([]);
  const [statusFilter, setStatusFilter] = createSignal<PlanStatus>();
  const [retentionFilter, setRetentionFilter] = createSignal<PlanRetention>();
  const [loadingError, setLoadingError] = createSignal("");
  const [activeHistoryWarning, setActiveHistoryWarning] = createSignal("");
  let userNavigated = false;
  let seededRevision = -1;
  let historyRequestSeq = 0;
  let documentRequestSeq = 0;

  const armedDelete = useArmedConfirm<PlanDocumentDto>(props.interaction.keymap, {
    message: (doc) => `delete plan "${doc.title}"?`,
    onYes: (doc) =>
      props
        .plans!.delete(doc.id)
        .then(() => {
          setHistory((items) => items.filter((item) => item.id !== doc.id));
          setDocument((current) => (current?.id === doc.id ? null : current));
          props.notify?.("plan deleted", "success");
        })
        .catch((error: unknown) =>
          props.notify?.(error instanceof Error ? error.message : String(error), "error"),
        ),
    watch: [historySel, statusFilter, retentionFilter, () => document()?.id],
  });

  async function readSelected(index = historySel()): Promise<void> {
    const item = history()[index];
    if (!props.plans || !item) return;
    const seq = ++documentRequestSeq;
    try {
      const doc = await props.plans.read(item.id);
      if (seq !== documentRequestSeq) return;
      setDocument(doc);
      setLoadingError("");
    } catch (error) {
      if (seq !== documentRequestSeq) return;
      setLoadingError(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadPlans(cursor?: string): Promise<void> {
    if (!props.plans) return;
    const seq = ++historyRequestSeq;
    try {
      const listed = await props.plans.list({
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
        ...(statusFilter() ? { status: statusFilter() } : {}),
        ...(retentionFilter() ? { retention: retentionFilter() } : {}),
      });
      if (seq !== historyRequestSeq) return;
      setHistory(listed.plans);
      setNextCursor(listed.next_cursor);
      const active = activePlan();
      const activeId = active?.id;
      const activeIndex = activeId ? listed.plans.findIndex((item) => item.id === activeId) : -1;
      setHistorySel(activeIndex >= 0 ? activeIndex : 0);
      if (activeId && activeIndex < 0) {
        setActiveHistoryWarning(
          `The active plan (${activeId}) is not in the selected provider's current history page. No other document was opened as the active plan.`,
        );
        setLoadingError("");
        return;
      }
      setActiveHistoryWarning("");
      if (active && focus() === "tasks") return;
      const selected = listed.plans[activeIndex >= 0 ? activeIndex : 0];
      const documentSeq = ++documentRequestSeq;
      const doc = selected ? await props.plans.read(selected.id) : null;
      if (seq !== historyRequestSeq || documentSeq !== documentRequestSeq) return;
      setDocument(doc);
      setLoadingError("");
    } catch (error) {
      if (seq !== historyRequestSeq) return;
      setLoadingError(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadActivePlan(): Promise<void> {
    const active = activePlan();
    if (!props.plans || !active) return;
    const seq = ++documentRequestSeq;
    try {
      const doc = await props.plans.read(active.id);
      if (seq !== documentRequestSeq) return;
      if (doc.id !== active.id) {
        setLoadingError(`plan service returned ${doc.id} while reading active plan ${active.id}`);
        return;
      }
      setDocument(doc);
      setLoadingError("");
    } catch (error) {
      if (seq !== documentRequestSeq) return;
      setLoadingError(error instanceof Error ? error.message : String(error));
    }
  }

  function cycleStatusFilter(): void {
    const current = STATUS_FILTERS.indexOf(statusFilter());
    setStatusFilter(STATUS_FILTERS[(current + 1) % STATUS_FILTERS.length]);
    setCursorStack([]);
    detachObserved("plans_filter_load", () => loadPlans());
  }

  function cycleRetentionFilter(): void {
    const current = RETENTION_FILTERS.indexOf(retentionFilter());
    setRetentionFilter(RETENTION_FILTERS[(current + 1) % RETENTION_FILTERS.length]);
    setCursorStack([]);
    detachObserved("plans_retention_filter_load", () => loadPlans());
  }

  function nextPage(): void {
    const cursor = nextCursor();
    if (!cursor) return;
    setCursorStack((stack) => [...stack, cursor]);
    detachObserved("plans_next_page", () => loadPlans(cursor));
  }

  function previousPage(): void {
    const stack = cursorStack();
    if (stack.length === 0) return;
    const previousCursor = stack.length > 1 ? stack[stack.length - 2] : undefined;
    setCursorStack(stack.slice(0, -1));
    detachObserved("plans_previous_page", () => loadPlans(previousCursor));
  }

  const tasks = (): PlanTaskActivity[] => {
    const live = activePlan();
    if (!live) return [];
    if (!props.plans || document() === null || document()?.id === live.id) return live.tasks;
    return [];
  };

  const clamp = (i: number): number => Math.max(0, Math.min(tasks().length - 1, i));
  const setSel = (i: number): void => {
    if (focus() === "history") {
      const next = Math.max(0, Math.min(history().length - 1, i));
      setHistorySel(next);
      detachObserved("plans_read_selected", () => readSelected(next));
      return;
    }
    userNavigated = true;
    setSelRaw(clamp(i));
  };

  createEffect(
    on(props.plan, (p) => {
      if (!p || p.removed) return;
      if (p.revision !== seededRevision) {
        seededRevision = p.revision;
        userNavigated = false;
      }
      if (userNavigated) return;
      const list = tasks();
      const next = ["in_progress", "returned", "pending"]
        .map((status) => list.findIndex((task) => task.status === status))
        .find((index) => index >= 0);
      setSelRaw(next ?? 0);
    }),
  );

  function openHistoryDetail(): void {
    if (focus() !== "history") return;
    const selected = history()[historySel()];
    if (selected && document()?.id !== selected.id)
      detachObserved("plans_open_history", () => readSelected());
    setFocus("tasks");
  }

  const spec = (): LevelSpec => ({
    ...(props.active ? { when: "overlay==plan" } : {}),
    ...(props.active ? { enabled: props.active } : {}),
    ...((focus() === "history" ? history().length : tasks().length) > 0
      ? {
          nav: {
            count: () => (focus() === "history" ? history().length : tasks().length),
            index: () => (focus() === "history" ? historySel() : sel()),
            setIndex: setSel,
            showArrows: true,
            ...(focus() === "history"
              ? { activate: { label: "open detail", run: openHistoryDetail } }
              : {}),
          },
        }
      : {}),
    verbs: [
      {
        key: "tab",
        label: focus() === "history" ? "tasks" : "history",
        when: () => props.plans !== undefined && history().length > 0,
        hintGroup: "navigation",
        hintPriority: 90,
        essential: true,
        run: () => setFocus((value) => (value === "history" ? "tasks" : "history")),
      },
      {
        key: "f",
        label: `status:${statusFilter() ?? "all"}`,
        when: () => props.plans !== undefined,
        run: cycleStatusFilter,
      },
      {
        key: "t",
        label: `retention:${retentionFilter() ?? "all"}`,
        when: () => props.plans !== undefined,
        run: cycleRetentionFilter,
      },
      {
        key: "[",
        label: "previous page",
        when: () => cursorStack().length > 0,
        run: previousPage,
      },
      {
        key: "]",
        label: "next page",
        when: () => nextCursor() !== undefined,
        run: nextPage,
      },
      {
        key: "v",
        label: "keep/delete",
        when: () => props.plans !== undefined && document() !== null,
        run: () => {
          const doc = document();
          if (!props.plans || !doc) return;
          const retention = doc.retention === "keep" ? "discard" : "keep";
          void props.plans
            .setRetention(doc.id, retention)
            .then((next) => {
              setDocument(next);
              setHistory((items) => items.map((item) => (item.id === next.id ? next : item)));
              props.notify?.(`this plan only: ${planHistoryLabel(retention)}`, "success");
            })
            .catch((error: unknown) =>
              props.notify?.(error instanceof Error ? error.message : String(error), "error"),
            );
        },
      },
      {
        key: "d",
        label: "delete",
        when: () => {
          const doc = document();
          return (
            props.plans !== undefined &&
            doc !== null &&
            doc.status !== "active" &&
            doc.status !== "awaiting_approval"
          );
        },
        run: () => {
          const doc = document();
          if (!props.plans || !doc || doc.status === "active" || doc.status === "awaiting_approval")
            return;
          armedDelete.arm(doc);
        },
      },
    ],
  });

  const scrollMode = createMemo(() => focus() === "tasks" && document() !== null);
  const scrollSpec = (): LevelSpec => {
    const base = spec();
    return {
      verbs: base.verbs,
      scroll: () => scrollEl,
      ...(base.when === undefined ? {} : { when: base.when }),
      ...(base.enabled === undefined ? {} : { enabled: base.enabled }),
    };
  };

  onMount(() => {
    const offEscape = props.interaction.keymap.registerLayer({
      ...(props.active ? { when: "overlay==plan" } : {}),
      ...(props.active ? { enabled: reactiveMatcherFromSignal(props.active) } : {}),
      priority: LAYER.OVERLAY + 1,
      commands: [
        uiCommand({
          id: "plan.escape",
          title: "Back or close plan",
          description: "Return to the screen that opened this plan",
          category: "escape",
          surfaces: ["footer"],
          footerLabel: "back / close",
          hintPriority: 100,
          hintGroup: "escape",
          essential: true,
          enabled: () => (focus() === "tasks" && props.plans !== undefined) || !!props.onClose,
          run: () => {
            if (focus() === "tasks" && props.plans && props.origin === "history") {
              setFocus("history");
              return;
            }
            props.onClose?.();
          },
        }),
        uiCommand({
          id: "plan.close",
          title: "Close plans",
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
  let wasActive = false;
  createEffect(() => {
    const active = props.active?.() ?? true;
    if (active && !wasActive) {
      setFocus(
        props.origin === "history" && props.plans
          ? "history"
          : activePlan() || !props.plans
            ? "tasks"
            : "history",
      );
      detachObserved("plans_initial_load", () => Promise.all([loadPlans(), loadActivePlan()]));
    } else if (!active && wasActive) {
      historyRequestSeq += 1;
      documentRequestSeq += 1;
    }
    wasActive = active;
  });
  createEffect(() => {
    if (armedDelete.armed() !== null) return;
    const active = scrollMode() ? scrollSpec() : spec();
    const off = registerLevel(props.interaction.keymap, active, LAYER.OVERLAY);
    onCleanup(off);
  });
  followSelection(
    () => scrollEl,
    "plan-",
    () => clamp(sel()),
  );
  followSelection(() => scrollEl, "plan-history-", historySel);

  const title = (): string => {
    if (focus() === "history") return `Plans ${glyph("separator")} History`;
    const doc = document();
    if (doc) return `Plans ${glyph("chevronRight")} ${doc.title}`;
    const p = activePlan();
    if (!p) return "Plans";
    const progress =
      p.status === "awaiting_approval"
        ? `${p.tasks.length} ${p.tasks.length === 1 ? "task" : "tasks"} proposed`
        : taskProgressLabel(p.tasks);
    return `Plans ${glyph("separator")} ${lifecycleLabel(uiLifecycle(p.status))} ${glyph("separator")} ${progress}`;
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

  function taskRow(p: PlanActivity, index: number): JSX.Element {
    const task = (): PlanTaskActivity => p.tasks[index]!;
    const g = (): ToneStyle => taskTone(task().status);
    const on = (): boolean => clamp(sel()) === index;
    // A terminal plan can still expand its last outcome, but it must not draw
    // the current-task chevron that denotes an active task.
    const hasCurrentTask = (): boolean =>
      p.status === "active" || p.status === "awaiting_approval" || userNavigated;
    return (
      <box flexDirection="column" paddingLeft={1}>
        <box
          flexDirection="row"
          width="100%"
          id={`plan-${index}`}
          backgroundColor={on() ? selectionBg(tokens.bg) : undefined}
        >
          <text fg={hasCurrentTask() && on() ? tokens.accent : tokens.muted} flexShrink={0}>
            {hasCurrentTask() && on() ? glyph("chevronRight") + " " : "  "}
          </text>
          <text fg={g().fg} flexShrink={0}>
            {g().glyph + " "}
          </text>
          <text
            fg={on() ? tokens.fg : task().status === "in_progress" ? tokens.fg : tokens.muted}
            wrapMode="word"
            flexGrow={1}
            flexBasis={0}
            minWidth={0}
          >
            {task().title + (task().assignee ? `  ${glyph("separator")} ${task().assignee}` : "")}
          </text>
        </box>
        <Show when={on() && task().description}>
          <box flexDirection="row" paddingLeft={4}>
            <Prose content={task().description ?? ""} fg={tokens.muted} />
          </box>
        </Show>
        <Show when={on() && task().exit_condition}>
          <box flexDirection="row" paddingLeft={4}>
            <text fg={tokens.muted} flexShrink={0}>
              {glyph("arrowRight") + " "}
            </text>
            <Prose content={task().exit_condition ?? ""} fg={tokens.muted} />
          </box>
        </Show>
        <Show when={on() && task().result}>
          {outcomeLine("result", task().result ?? "", tokens.fg)}
        </Show>
        <Show when={on() && task().error}>
          {outcomeLine("error", task().error ?? "", tokens.del)}
        </Show>
        <Show when={on() && task().reason}>
          {outcomeLine("reason", task().reason ?? "", tokens.muted)}
        </Show>
      </box>
    );
  }

  return (
    <PageFrame title={title()} interaction={props.interaction}>
      <Show when={armedDelete.message()}>
        <text fg={tokens.del}>{glyph("warning") + " " + armedDelete.message()}</text>
      </Show>
      <scrollbox
        ref={(el: ScrollBoxRenderable) => (scrollEl = el)}
        flexGrow={1}
        paddingRight={SCROLLBOX_TABLE_GUTTER}
        verticalScrollbarOptions={scrollbarOptions()}
      >
        <Show
          when={activePlan() || history().length > 0}
          fallback={
            <EmptyHint
              text="no plans yet"
              icon="info"
              hint="start a task with planning enabled; live and saved plans appear here"
            />
          }
        >
          {() => (
            <box flexDirection="column">
              <Show when={focus() === "history" && history().length > 0}>
                <box flexDirection="column" paddingBottom={1}>
                  <text fg={tokens.muted}>
                    {`history ${glyph("separator")} ${history().length} plan${history().length === 1 ? "" : "s"} ${glyph("separator")} status:${statusFilter() ?? "all"} ${glyph("separator")} retention:${retentionFilter() ?? "all"}`}
                  </text>
                  <For each={history()}>
                    {(item, index) => {
                      const onRow = (): boolean =>
                        focus() === "history" && index() === historySel();
                      const fg = (): string => (onRow() ? tokens.accent : tokens.muted);
                      return (
                        <PickerRow
                          selected={onRow()}
                          base={tokens.bg}
                          id={`plan-history-${index()}`}
                          cells={[
                            {
                              width: STATUS_COL_WIDTH,
                              text: lifecycleLabel(uiLifecycle(item.status)),
                              fg: fg(),
                            },
                            {
                              width: RETENTION_COL_WIDTH,
                              text: item.retention === "keep" ? "Keep" : "Delete",
                              fg: fg(),
                            },
                            { grow: true, text: item.title, fg: fg() },
                          ]}
                          onSelect={() => {
                            setFocus("history");
                            setHistorySel(index());
                          }}
                          onConfirm={() => {
                            detachObserved("plans_confirm_history", () => readSelected(index()));
                            setFocus("tasks");
                          }}
                        />
                      );
                    }}
                  </For>
                </box>
              </Show>
              <Show when={focus() === "tasks" && document()}>
                {(doc: Accessor<PlanDocumentDto>) => (
                  <box flexDirection="column" paddingBottom={1}>
                    <text fg={tokens.muted} wrapMode="word">
                      {`${lifecycleLabel(uiLifecycle(doc().status))} ${glyph("separator")} ${taskProgressLabel(doc().tasks)} ${glyph("separator")} ${planHistoryLabel(doc().retention)}`}
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
              <Show when={activeHistoryWarning()}>
                <box flexDirection="column" paddingBottom={1}>
                  <text fg={tokens.warn} wrapMode="word">
                    {activeHistoryWarning()}
                  </text>
                </box>
              </Show>
              <Show when={focus() === "tasks" && activePlan()?.reviewOutcome}>
                <text fg={tokens.muted} wrapMode="word">
                  {glyph("separator") + " review: " + activePlan()!.reviewOutcome}
                </text>
              </Show>
              <Show when={focus() === "tasks" && !document() && activePlan()}>
                {(p: Accessor<PlanActivity>) => (
                  <For each={tasks()}>{(_, index) => taskRow(p(), index())}</For>
                )}
              </Show>
              <Show when={focus() === "tasks" && !document() && !activePlan()}>
                <LoadingHint text="loading plan detail" />
              </Show>
            </box>
          )}
        </Show>
      </scrollbox>
    </PageFrame>
  );
}
