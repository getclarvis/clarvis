import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import type { Accessor, JSX } from "solid-js";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type {
  TaskContainerRefDto,
  TaskDocumentDto,
  TaskProviderCapabilitiesDto,
  TaskProviderStatusDto,
  TaskStageDto,
  TaskSummaryDto,
  TaskTransitionIntentDto,
} from "@clarvis/protocol";
import { errorText } from "../../adapters/errors.ts";
import { padColumn } from "../truncate.ts";
import { detachObserved } from "../../core/tasks.ts";
import type { TasksController } from "../../features/tasks/controller.ts";
import type { ViewHost } from "../../keys/commands.ts";
import { glyph } from "../../theme/glyphs.ts";
import { tokens } from "../../theme/tokens.ts";
import { clampListIndex } from "../../ui/patterns/list-navigation.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { scrollbarOptions, selectionBg } from "../../theme/surfaces.ts";
import {
  bindLevelKeys,
  createFieldEditor,
  ErrorBanner,
  LoadingHint,
  SelectableList,
  SelectableRow,
  StatusRow,
  ViewFrame,
} from "./view-host.tsx";

const PRIMARY_STAGES: readonly TaskStageDto[] = [
  "backlog",
  "ready",
  "active",
  "blocked",
  "review",
  "done",
];
const EXTRA_STAGES: readonly TaskStageDto[] = ["cancelled", "other"];
const STAGE_LABELS: Record<TaskStageDto, string> = {
  backlog: "Backlog",
  ready: "Ready",
  active: "Active",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
  cancelled: "Cancelled",
  other: "Other",
};

type Screen = "tasks" | "detail" | "profiles" | "containers" | "intents";
type ViewMode = "board" | "list";
type FaultKind = "fault" | "conflict" | "outcome_unknown";

export interface TasksHubDeps {
  controller: TasksController;
  profiles: () => {
    name: string;
    model?: string;
    grants?: readonly string[] | "unknown";
  }[];
  defaultContainer: () => string | undefined;
  /** Host-level model-work gate, checked both before and after agent selection. */
  workBlockedReason?: () => string | null;
  onError: (message: string) => void;
}

function sameTask(left: TaskSummaryDto, right: TaskSummaryDto): boolean {
  return left.ref.provider_key === right.ref.provider_key && left.ref.id === right.ref.id;
}

function taskMeta(task: TaskSummaryDto): string {
  const assignee = task.assignee?.label ?? "unassigned";
  const claim = task.claim ? `claimed by ${task.claim.claimant.label}` : "free";
  const native =
    task.native_state.label === STAGE_LABELS[task.stage] ? "" : task.native_state.label;
  return [assignee, claim, native].filter(Boolean).join(` ${glyph("separator")} `);
}

function taskFromFailure(error: unknown): TaskDocumentDto | undefined {
  if (typeof error !== "object" || error === null || !("details" in error)) return undefined;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== "object" || details === null || !("current_task" in details)) {
    return undefined;
  }
  const task = (details as { current_task?: unknown }).current_task;
  if (typeof task !== "object" || task === null || !("ref" in task) || !("title" in task)) {
    return undefined;
  }
  return task as TaskDocumentDto;
}

function faultOf(error: unknown): { kind: FaultKind; text: string } {
  const details =
    typeof error === "object" && error !== null && "details" in error
      ? (error as { details?: unknown }).details
      : undefined;
  if (
    typeof details === "object" &&
    details !== null &&
    "outcome_unknown" in details &&
    details.outcome_unknown === true
  ) {
    return {
      kind: "outcome_unknown",
      text: `outcome unknown ${glyph("emDash")} the task was re-read; inspect it before trying again`,
    };
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return {
    kind: code === "conflict" ? "conflict" : "fault",
    text: errorText(error),
  };
}

/** Provider-neutral Tasks board. All reads and writes cross `KernelClient.tasks`. */
export function TasksHub(host: ViewHost, deps: TasksHubDeps): JSX.Element {
  const editor = createFieldEditor(host.interaction, host.active);
  const dimensions = useTerminalDimensions();
  const [screen, setScreen] = createSignal<Screen>("tasks");
  const [mode, setMode] = createSignal<ViewMode>("board");
  const [status, setStatus] = createSignal<TaskProviderStatusDto | null>(null);
  const [capabilities, setCapabilities] = createSignal<TaskProviderCapabilitiesDto | null>(null);
  const [containers, setContainers] = createSignal<TaskContainerRefDto[]>([]);
  const [containerId, setContainerId] = createSignal(deps.defaultContainer() ?? "");
  const [query, setQuery] = createSignal("");
  const [showExtras, setShowExtras] = createSignal(false);
  const [rows, setRows] = createSignal<TaskSummaryDto[]>([]);
  const [detail, setDetail] = createSignal<TaskDocumentDto | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [fault, setFault] = createSignal<{ kind: FaultKind; text: string } | null>(null);
  const [lastRead, setLastRead] = createSignal<string | null>(null);
  const [sel, setSel] = createSignal(0);
  const [profileSel, setProfileSel] = createSignal(0);
  const [containerSel, setContainerSel] = createSignal(0);
  const [intentSel, setIntentSel] = createSignal(0);
  const [workTarget, setWorkTarget] = createSignal<TaskSummaryDto | TaskDocumentDto | null>(null);
  let refreshAbort: AbortController | undefined;
  let detailAbort: AbortController | undefined;
  let intentAbort: AbortController | undefined;
  let boardScroll: ScrollBoxRenderable | undefined;
  const screenStack: Screen[] = [];

  const stages = (): readonly TaskStageDto[] =>
    showExtras() ? [...PRIMARY_STAGES, ...EXTRA_STAGES] : PRIMARY_STAGES;
  const visibleRows = createMemo(() => {
    const visible = new Set(stages());
    return rows().filter((task) => visible.has(task.stage));
  });
  const selected = (): TaskSummaryDto | undefined =>
    visibleRows()[clampListIndex(sel(), visibleRows().length)];
  const legalIntents = createMemo(() =>
    (detail()?.available_intents ?? []).filter(
      (intent): intent is Exclude<TaskTransitionIntentDto, "start"> => intent !== "start",
    ),
  );
  const writesReady = (): boolean => status()?.writes === "enabled";
  const canCreate = (): boolean => writesReady() && capabilities()?.write.create === true;
  const canAssign = (): boolean => writesReady() && capabilities()?.write.assign === true;
  const canComment = (): boolean => writesReady() && capabilities()?.write.comment === true;
  const canTransition = (): boolean =>
    writesReady() && (capabilities()?.write.intents.some((intent) => intent !== "start") ?? false);
  const concurrency = (): string => {
    switch (capabilities()?.concurrency) {
      case "exclusive_claim":
        return "exclusive claim";
      case "revision":
        return "revision only";
      case "none":
        return "claim not enforced";
      default:
        return "unknown";
    }
  };

  function replaceSnapshot(document: TaskDocumentDto): void {
    setRows((current) => {
      const index = current.findIndex((item) => sameTask(item, document));
      if (index < 0) return [document, ...current];
      return current.map((item, itemIndex) => (itemIndex === index ? document : item));
    });
    if (detail() && sameTask(detail()!, document)) setDetail(document);
    setLastRead(new Date().toLocaleTimeString());
  }

  function fail(error: unknown): void {
    const recovered = taskFromFailure(error);
    if (recovered) replaceSnapshot(recovered);
    const next = faultOf(error);
    setFault(next);
    deps.onError(next.text);
  }

  const isCurrentRefresh = (controller: AbortController): boolean =>
    refreshAbort === controller && !controller.signal.aborted;

  async function search(controller: AbortController): Promise<void> {
    const selectedBefore = selected()?.ref.id;
    const page = await deps.controller.search(
      {
        ...(containerId() ? { container_id: containerId() } : {}),
        ...(query().trim() ? { query: query().trim() } : {}),
        limit: 100,
      },
      controller.signal,
    );
    if (!isCurrentRefresh(controller)) return;
    setRows(page.items);
    const nextIndex =
      selectedBefore === undefined
        ? 0
        : page.items.findIndex((item) => item.ref.id === selectedBefore);
    setSel(nextIndex < 0 ? 0 : nextIndex);
    setLastRead(new Date().toLocaleTimeString());
  }

  function reload(): void {
    refreshAbort?.abort();
    const controller = new AbortController();
    refreshAbort = controller;
    setLoading(true);
    setFault(null);
    detachObserved("tasks_reload", async () => {
      try {
        if (!isCurrentRefresh(controller)) return;
        if (!deps.controller.available()) {
          setStatus({
            state: "not_configured",
            writes: "disabled",
            reason: "Tasks are disabled in this host.",
          });
          setCapabilities(null);
          setContainers([]);
          setRows([]);
          return;
        }
        const nextStatus = await deps.controller.status(controller.signal);
        if (!isCurrentRefresh(controller)) return;
        setStatus(nextStatus);
        if (nextStatus.state !== "ready") {
          setCapabilities(null);
          setContainers([]);
          setRows([]);
          setFault(
            nextStatus.state === "not_configured"
              ? null
              : { kind: "fault", text: nextStatus.reason ?? `provider ${nextStatus.state}` },
          );
          return;
        }
        const [nextCapabilities, nextContainers] = await Promise.all([
          deps.controller.capabilities(controller.signal),
          deps.controller.listContainers({ limit: 100 }, controller.signal),
        ]);
        if (!isCurrentRefresh(controller)) return;
        setCapabilities(nextCapabilities);
        setContainers(nextContainers.items);
        const preferred = containerId() || deps.defaultContainer() || "";
        if (preferred && nextContainers.items.some((item) => item.id === preferred)) {
          setContainerId(preferred);
        }
        await search(controller);
      } catch (error) {
        if (isCurrentRefresh(controller)) fail(error);
      } finally {
        if (refreshAbort === controller) {
          refreshAbort = undefined;
          setLoading(false);
        }
      }
    });
  }

  reload();
  onCleanup(() => {
    refreshAbort?.abort();
    detailAbort?.abort();
    intentAbort?.abort();
  });

  function enter(next: Screen, title: string): void {
    screenStack.push(screen());
    setScreen(next);
    host.level.push(title);
  }

  function leave(): void {
    const current = screen();
    if (current === "detail") {
      detailAbort?.abort();
      detailAbort = undefined;
      setDetail(null);
    }
    if (current === "profiles") setWorkTarget(null);
    setScreen(screenStack.pop() ?? "tasks");
    host.level.pop();
  }

  function openDetail(): void {
    const task = selected();
    if (!task) return;
    detailAbort?.abort();
    const controller = new AbortController();
    detailAbort = controller;
    setDetail(null);
    setFault(null);
    enter("detail", task.ref.id);
    detachObserved("task_detail", async () => {
      try {
        const document = await deps.controller.get(task.ref, controller.signal);
        if (
          detailAbort !== controller ||
          controller.signal.aborted ||
          screen() !== "detail" ||
          !sameTask(task, document)
        ) {
          return;
        }
        setDetail(document);
        replaceSnapshot(document);
      } catch (error) {
        if (detailAbort === controller && !controller.signal.aborted && screen() === "detail") {
          fail(error);
        }
      } finally {
        if (detailAbort === controller) detailAbort = undefined;
      }
    });
  }

  function beginWork(): void {
    const task = screen() === "detail" ? detail() : selected();
    if (!task) return;
    const hostBlock = deps.workBlockedReason?.();
    if (hostBlock) {
      deps.onError(hostBlock);
      return;
    }
    if (deps.controller.workBlocked()) {
      deps.onError("finish the active run before starting work on another task");
      return;
    }
    setProfileSel(
      Math.max(
        0,
        deps
          .profiles()
          .findIndex(
            (profile) =>
              Array.isArray(profile.grants) &&
              profile.grants.some((grant) => grant === "tasks.read" || grant === "tasks.progress"),
          ),
      ),
    );
    setWorkTarget(task);
    enter("profiles", "Choose agent");
  }

  function chooseProfile(): void {
    const task = workTarget();
    const profile = deps.profiles()[clampListIndex(profileSel(), deps.profiles().length)];
    if (!task || !profile) return;
    const hostBlock = deps.workBlockedReason?.();
    if (hostBlock) {
      deps.onError(hostBlock);
      return;
    }
    if (deps.controller.workBlocked()) {
      deps.onError("finish the active run before starting work on another task");
      return;
    }
    host.close();
    detachObserved(
      "task_work",
      () => deps.controller.workOnTask(task.ref, profile.name),
      (error) => deps.onError(errorText(error)),
    );
  }

  function chooseContainer(): void {
    const item = containers()[clampListIndex(containerSel(), containers().length)];
    if (!item) return;
    setContainerId(item.id);
    leave();
    reload();
  }

  function editSearch(): void {
    editor.start(
      "task search",
      query(),
      (value) => {
        setQuery(value);
        reload();
      },
      { alwaysCommit: true },
    );
  }

  function createTask(): void {
    if (!canCreate()) return;
    const providerKey = status()?.provider_key;
    if (!providerKey) {
      deps.onError("refresh Tasks before creating against this provider");
      return;
    }
    const targetContainer = containerId() || deps.defaultContainer();
    if (!targetContainer) {
      deps.onError("choose a container before creating a task");
      return;
    }
    editor.start("task title", "", (title) => {
      if (!title.trim()) return;
      detachObserved("task_create", () =>
        deps.controller
          .create({
            provider_key: providerKey,
            container_id: targetContainer,
            title: title.trim(),
          })
          .then(replaceSnapshot)
          .catch(fail),
      );
    });
  }

  function assignTask(): void {
    const task = screen() === "detail" ? detail() : selected();
    if (!task || !canAssign()) return;
    editor.start(
      "assignee id (blank = unassign)",
      task.assignee?.id ?? "",
      (value) => {
        detachObserved("task_assign", () =>
          deps.controller
            .assign({
              ref: task.ref,
              assignee_id: value.trim() || null,
              ...(task.revision ? { expected_revision: task.revision } : {}),
            })
            .then(replaceSnapshot)
            .catch(fail),
        );
      },
      { alwaysCommit: true },
    );
  }

  function commentTask(): void {
    const task = screen() === "detail" ? detail() : selected();
    if (!task || !canComment()) return;
    editor.startMultiline("task comment", "", (body) => {
      if (!body.trim()) return;
      detachObserved("task_comment", () =>
        deps.controller
          .comment({
            ref: task.ref,
            body: body.trim(),
            ...(task.revision ? { expected_revision: task.revision } : {}),
          })
          .then(replaceSnapshot)
          .catch(fail),
      );
    });
  }

  function openIntents(): void {
    const origin = screen();
    if (origin !== "tasks" && origin !== "detail") return;
    const task = screen() === "detail" ? detail() : selected();
    if (!task || !writesReady()) return;
    const use = (document: TaskDocumentDto): void => {
      setDetail(document);
      setIntentSel(0);
      enter("intents", "Transition");
    };
    intentAbort?.abort();
    const current = detail();
    if (current && sameTask(current, task)) {
      intentAbort = undefined;
      use(current);
      return;
    }
    const controller = new AbortController();
    intentAbort = controller;
    const targetIsCurrent = (): boolean => {
      const currentTarget = origin === "detail" ? detail() : selected();
      return currentTarget !== undefined && currentTarget !== null && sameTask(currentTarget, task);
    };
    detachObserved("task_intents", async () => {
      try {
        const document = await deps.controller.get(task.ref, controller.signal);
        if (
          intentAbort !== controller ||
          controller.signal.aborted ||
          screen() !== origin ||
          !targetIsCurrent() ||
          !sameTask(document, task)
        ) {
          return;
        }
        intentAbort = undefined;
        use(document);
      } catch (error) {
        if (
          intentAbort === controller &&
          !controller.signal.aborted &&
          screen() === origin &&
          targetIsCurrent()
        ) {
          fail(error);
        }
      } finally {
        if (intentAbort === controller) intentAbort = undefined;
      }
    });
  }

  function transition(intent: Exclude<TaskTransitionIntentDto, "start">, reason?: string): void {
    const task = detail();
    if (!task) return;
    detachObserved("task_transition", async () => {
      try {
        let confirmationToken: string | undefined;
        if (intent === "complete" || intent === "reopen") {
          const preview = await deps.controller.previewTransition({
            ref: task.ref,
            intent,
            ...(task.revision ? { expected_revision: task.revision } : {}),
          });
          const confirmed = await host.confirm({
            message: `${intent === "complete" ? "Complete" : "Reopen"} ${task.ref.id}?`,
            detail: [`stage: ${preview.task.stage}`, `state: ${preview.task.native_state.label}`],
            confirmLabel: intent,
            cancelLabel: "cancel",
            danger: intent === "reopen",
          });
          if (!confirmed) return;
          confirmationToken = preview.confirmation_token;
        }
        const document = await deps.controller.transition({
          ref: task.ref,
          intent,
          ...(reason?.trim() ? { reason: reason.trim() } : {}),
          ...(task.revision ? { expected_revision: task.revision } : {}),
          ...(confirmationToken ? { confirmation_token: confirmationToken } : {}),
        });
        replaceSnapshot(document);
        leave();
      } catch (error) {
        fail(error);
      }
    });
  }

  function chooseIntent(): void {
    const intent = legalIntents()[clampListIndex(intentSel(), legalIntents().length)];
    if (!intent) return;
    if (intent === "block") {
      editor.start("blocking reason", "", (reason) => {
        if (reason.trim()) transition(intent, reason);
      });
      return;
    }
    transition(intent);
  }

  const rootVerbs = () => [
    { key: "r", label: "refresh", run: reload, category: "navigation" },
    {
      key: "b",
      label: mode() === "board" ? "list" : "board",
      run: () => setMode((value) => (value === "board" ? "list" : "board")),
      category: "navigation",
    },
    { key: "/", label: "search", run: editSearch, category: "navigation" },
    {
      key: "o",
      label: "container",
      when: () => containers().length > 0,
      run: () => enter("containers", "Container"),
      category: "navigation",
    },
    {
      key: "x",
      label: showExtras() ? "hide extra" : "show extra",
      when: () => showExtras() || rows().length > 0,
      run: () => setShowExtras((value) => !value),
      category: "navigation",
    },
    { key: "w", label: "work", when: () => selected() !== undefined, run: beginWork },
    { key: "c", label: "create", when: canCreate, run: createTask },
    {
      key: "a",
      label: "assign",
      when: () => selected() !== undefined && canAssign(),
      run: assignTask,
    },
    {
      key: "t",
      label: "transition",
      when: () => selected() !== undefined && canTransition(),
      run: openIntents,
    },
    {
      key: "m",
      label: "comment",
      when: () => selected() !== undefined && canComment(),
      run: commentTask,
    },
  ];

  const spec = (): LevelSpec => {
    switch (screen()) {
      case "profiles":
        return {
          nav: {
            count: () => deps.profiles().length,
            index: profileSel,
            setIndex: setProfileSel,
            activate: { label: "work", run: chooseProfile },
          },
          escape: { label: "back", run: leave },
        };
      case "containers":
        return {
          nav: {
            count: () => containers().length,
            index: containerSel,
            setIndex: setContainerSel,
            activate: { label: "select", run: chooseContainer },
          },
          escape: { label: "back", run: leave },
        };
      case "intents":
        return {
          nav: {
            count: () => legalIntents().length,
            index: intentSel,
            setIndex: setIntentSel,
            activate: { label: "apply", run: chooseIntent },
          },
          escape: { label: "back", run: leave },
        };
      case "detail":
        return {
          verbs: [
            { key: "w", label: "work", when: () => detail() !== null, run: beginWork },
            {
              key: "a",
              label: "assign",
              when: () => detail() !== null && canAssign(),
              run: assignTask,
            },
            {
              key: "t",
              label: "transition",
              when: () => detail() !== null && canTransition() && legalIntents().length > 0,
              run: openIntents,
            },
            {
              key: "m",
              label: "comment",
              when: () => detail() !== null && canComment(),
              run: commentTask,
            },
          ],
          escape: { label: "back", run: leave },
        };
      default:
        return {
          nav: {
            count: () => visibleRows().length,
            index: sel,
            setIndex: setSel,
            activate: { label: "details", run: openDetail, when: () => selected() !== undefined },
          },
          verbs: rootVerbs(),
        };
    }
  };

  bindLevelKeys({
    host,
    editor,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  createEffect(() => {
    const current = sel();
    boardScroll?.scrollChildIntoView(`task-board-${current}`);
  });

  const columnsPerRow = (): number =>
    dimensions().width >= 132 ? 6 : dimensions().width >= 88 ? 3 : 1;
  const stageRows = createMemo(() => {
    const all = [...stages()];
    const width = columnsPerRow();
    const result: TaskStageDto[][] = [];
    for (let index = 0; index < all.length; index += width)
      result.push(all.slice(index, index + width));
    return result;
  });
  const rowIndex = (task: TaskSummaryDto): number =>
    visibleRows().findIndex((candidate) => sameTask(candidate, task));

  function providerHeader(): JSX.Element {
    const current = status();
    return (
      <box flexDirection="column" flexShrink={0}>
        <StatusRow
          label="provider"
          text={
            current === null
              ? "checking"
              : `${current.state}${current.provider_kind ? ` · ${current.provider_kind}` : ""}${current.server ? ` · ${current.server}` : ""}`
          }
          fg={current?.state === "ready" ? tokens.add : tokens.warn}
        />
        <StatusRow
          label="view"
          text={`${mode()} · ${containerId() || "all containers"}${query() ? ` · /${query()}/` : ""}`}
          fg={tokens.muted}
        />
        <StatusRow
          label="policy"
          text={`${current?.writes ?? "disabled"} writes · ${concurrency()}${lastRead() ? ` · read ${lastRead()}` : ""}`}
          fg={capabilities()?.concurrency === "none" ? tokens.warn : tokens.muted}
        />
      </box>
    );
  }

  function listBody(): JSX.Element {
    return (
      <SelectableList<TaskSummaryDto>
        each={visibleRows}
        sel={sel}
        idPrefix="task-list-"
        loading={loading}
        error={() => (rows().length === 0 ? (fault()?.text ?? null) : null)}
        empty={() => ({
          text:
            status()?.state === "not_configured"
              ? "Tasks provider is not configured"
              : "no tasks match",
          icon: "info",
        })}
        row={(task, index) => (
          <SelectableRow selected={sel() === index()}>
            <span style={{ fg: tokens.accent2 }}>{padColumn(task.ref.id, 12)}</span>
            <span style={{ fg: tokens.fg }}>{task.title}</span>
            <span
              style={{ fg: tokens.muted }}
            >{`  ${STAGE_LABELS[task.stage]} · ${taskMeta(task)}`}</span>
          </SelectableRow>
        )}
      />
    );
  }

  function boardBody(): JSX.Element {
    return (
      <Show
        when={visibleRows().length > 0}
        fallback={
          <Show
            when={loading()}
            fallback={
              <Show
                when={fault()}
                fallback={
                  <text fg={tokens.muted}>
                    {status()?.state === "not_configured"
                      ? "Tasks provider is not configured"
                      : "no tasks match"}
                  </text>
                }
              >
                {(current: Accessor<{ kind: FaultKind; text: string }>) => (
                  <ErrorBanner text={current().text} />
                )}
              </Show>
            }
          >
            <LoadingHint />
          </Show>
        }
      >
        <scrollbox
          ref={(element: ScrollBoxRenderable) => (boardScroll = element)}
          flexGrow={1}
          minHeight={0}
          verticalScrollbarOptions={scrollbarOptions()}
        >
          <For each={stageRows()}>
            {(stageRow) => (
              <box width="100%" flexDirection="row" flexShrink={0} paddingBottom={1}>
                <For each={stageRow}>
                  {(stage) => {
                    const tasks = () => visibleRows().filter((task) => task.stage === stage);
                    return (
                      <box
                        width={`${100 / columnsPerRow()}%`}
                        flexDirection="column"
                        paddingRight={1}
                      >
                        <text fg={tokens.accent} flexShrink={0}>
                          <b>{`${STAGE_LABELS[stage]} (${tasks().length})`}</b>
                        </text>
                        <Show
                          when={tasks().length > 0}
                          fallback={<text fg={tokens.muted}> empty</text>}
                        >
                          <For each={tasks()}>
                            {(task) => {
                              const index = () => rowIndex(task);
                              const active = () => sel() === index();
                              return (
                                <box
                                  id={`task-board-${index()}`}
                                  flexDirection="column"
                                  flexShrink={0}
                                  backgroundColor={active() ? selectionBg(tokens.bg) : undefined}
                                  paddingBottom={1}
                                >
                                  <text wrapMode="none" truncate>
                                    <span style={{ fg: active() ? tokens.accent : tokens.muted }}>
                                      {active() ? `${glyph("chevronRight")} ` : "  "}
                                    </span>
                                    <span style={{ fg: tokens.accent2 }}>{task.ref.id + " "}</span>
                                    <span style={{ fg: tokens.fg }}>{task.title}</span>
                                  </text>
                                  <text fg={tokens.muted} wrapMode="none" truncate>
                                    {`  ${taskMeta(task)}`}
                                  </text>
                                </box>
                              );
                            }}
                          </For>
                        </Show>
                      </box>
                    );
                  }}
                </For>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
    );
  }

  function detailBody(): JSX.Element {
    const task = detail();
    return (
      <Show when={task} fallback={fault() ? <ErrorBanner text={fault()!.text} /> : <LoadingHint />}>
        {(document: () => TaskDocumentDto) => (
          <scrollbox flexGrow={1} minHeight={0} verticalScrollbarOptions={scrollbarOptions()}>
            <StatusRow
              label="task"
              text={`${document().ref.id} · ${document().title}`}
              fg={tokens.fg}
            />
            <StatusRow label="provider" text={document().ref.provider_key} fg={tokens.muted} />
            <StatusRow
              label="container"
              text={`${document().container.label} (${document().container.id})`}
              fg={tokens.muted}
            />
            <StatusRow
              label="stage"
              text={`${document().stage} · ${document().native_state.label}`}
              fg={tokens.accent2}
            />
            <StatusRow
              label="assignee"
              text={document().assignee?.label ?? "unassigned"}
              fg={tokens.muted}
            />
            <StatusRow
              label="claim"
              text={
                document().claim?.claimant.label !== undefined
                  ? `${document().claim?.claimant.label} · ${document().claim?.execution_id}`
                  : "free"
              }
              fg={tokens.muted}
            />
            <StatusRow
              label="revision"
              text={document().revision ?? "not enforced"}
              fg={document().revision ? tokens.muted : tokens.warn}
            />
            <StatusRow
              label="intents"
              text={document().available_intents.join(", ") || "none"}
              fg={tokens.muted}
            />
            <Show when={document().url}>
              <StatusRow label="url" text={document().url!} fg={tokens.accent2} />
            </Show>
            <Show when={document().description}>
              <text fg={tokens.fg} paddingTop={1} wrapMode="word">
                {document().description}
              </text>
            </Show>
            <Show when={document().acceptance_criteria.length > 0}>
              <box flexDirection="column" paddingTop={1}>
                <text fg={tokens.accent}>Acceptance criteria</text>
                <For each={document().acceptance_criteria}>
                  {(criterion) => <text fg={tokens.fg} wrapMode="word">{`- ${criterion}`}</text>}
                </For>
              </box>
            </Show>
          </scrollbox>
        )}
      </Show>
    );
  }

  function profileBody(): JSX.Element {
    return (
      <SelectableList<ReturnType<TasksHubDeps["profiles"]>[number]>
        each={deps.profiles}
        sel={profileSel}
        idPrefix="task-profile-"
        empty={() => ({ text: "no runnable agents", icon: "info" })}
        row={(profile, index) => (
          <SelectableRow selected={profileSel() === index()}>
            <span style={{ fg: tokens.fg }}>{profile.name}</span>
            <span
              style={{ fg: tokens.muted }}
            >{`  ${profile.model ?? "inherited model"} · ${Array.isArray(profile.grants) ? profile.grants.filter((grant) => grant.startsWith("tasks.")).join(", ") || "no Tasks grants" : "grants unknown"}`}</span>
          </SelectableRow>
        )}
      />
    );
  }

  function containerBody(): JSX.Element {
    return (
      <SelectableList<TaskContainerRefDto>
        each={containers}
        sel={containerSel}
        idPrefix="task-container-"
        empty={() => ({ text: "provider returned no containers", icon: "info" })}
        row={(container, index) => (
          <SelectableRow selected={containerSel() === index()}>
            <span style={{ fg: tokens.fg }}>{container.label}</span>
            <span
              style={{ fg: tokens.muted }}
            >{`  ${container.id} · ${container.kind ?? "other"}`}</span>
          </SelectableRow>
        )}
      />
    );
  }

  function intentBody(): JSX.Element {
    return (
      <SelectableList<Exclude<TaskTransitionIntentDto, "start">>
        each={legalIntents}
        sel={intentSel}
        idPrefix="task-intent-"
        empty={() => ({ text: "no legal human transition", icon: "info" })}
        row={(intent, index) => (
          <SelectableRow selected={intentSel() === index()}>
            <span style={{ fg: tokens.fg }}>{intent.replaceAll("_", " ")}</span>
            <span style={{ fg: tokens.muted }}>
              {intent === "complete" || intent === "reopen" ? "  confirmation required" : ""}
            </span>
          </SelectableRow>
        )}
      />
    );
  }

  return (
    <ViewFrame host={host} title="Tasks" unscoped>
      <Show when={screen() === "tasks"}>
        {providerHeader()}
        <Show when={fault() && rows().length > 0}>
          <ErrorBanner text={fault()!.text} />
        </Show>
        <Show when={mode() === "board"} fallback={listBody()}>
          {boardBody()}
        </Show>
      </Show>
      <Show when={screen() === "detail"}>{detailBody()}</Show>
      <Show when={screen() === "profiles"}>{profileBody()}</Show>
      <Show when={screen() === "containers"}>{containerBody()}</Show>
      <Show when={screen() === "intents"}>{intentBody()}</Show>
      <Show when={editor.editing()}>{editor.EditInput()}</Show>
      {editor.PickerInput()}
    </ViewFrame>
  );
}
