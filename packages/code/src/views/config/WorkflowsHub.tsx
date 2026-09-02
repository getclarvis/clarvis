import type { Accessor, JSX } from "solid-js";
import { detachObserved } from "../../core/tasks.ts";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import type {
  Page,
  RunDetail,
  RunStatus,
  RunUsage,
  WorkflowDetail,
  WorkflowNode,
  WorkflowSummary,
  WorkflowSequence,
} from "@clarvis/protocol";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import { scrollbarOptions, SCROLLBOX_TABLE_GUTTER } from "../../theme/surfaces.ts";
import type { ViewHost } from "../../keys/commands.ts";
import { clampListIndex } from "../../ui/patterns/list-navigation.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { bindLevelKeys, SelectableList, SelectableRow, ViewFrame } from "./view-host.tsx";
import { Prose } from "../Prose.tsx";
import { relTime } from "../session-row.ts";
import { lifecycleLabel, scopedUsageText, uiLifecycle } from "../../ui/presentation.ts";
import { PickerRow } from "../overlays/PickerRow.tsx";
import type { WorkflowActivity } from "../../adapters/workflow-projection.ts";
import { diagnosticAsync, diagnosticCount } from "../../core/diagnostic-events.ts";
import {
  formatStructuredWorkflowResult,
  parseStructuredWorkflowResult,
} from "./workflow-result.ts";

/** Data and actions {@link WorkflowsHub} needs from its host. */
export interface WorkflowsHubDeps {
  list: () => Promise<Page<WorkflowSummary>>;
  get: (id: string) => Promise<WorkflowDetail>;
  getRun: (id: string) => Promise<RunDetail | null>;
  delete?: (id: string) => Promise<void>;
  now: () => number;
  /** Live manager projection, merged over persisted records while this run is active. */
  live?: () => WorkflowActivity | null;
  openAgentPicker?: () => void;
  pollMs?: number;
  /** Internal test seam for the pending-operation warning. */
  refreshSlowMs?: number;
}

type NodePage =
  | { mode: "result"; meta: WorkflowNode; run: RunDetail | null }
  | { mode: "task"; meta: WorkflowNode };

function statusColor(status: RunStatus): string {
  if (status === "running") return tokens.warn;
  if (status === "completed") return tokens.fg;
  return tokens.del;
}

const glyphFor = (kind: WorkflowNode["kind"]): string =>
  kind === "manager" ? glyph("diamond") : glyph("chevronRight");

/** Best-effort text of a run's final result, for the node-detail pane. */
function resultText(run: RunDetail | null, meta: WorkflowNode): string {
  if (run === null)
    return meta.status === "running"
      ? "Agent is running. This view refreshes automatically" + glyph("ellipsis")
      : "Run detail is not available yet.";
  if (run.result?.error) return "error: " + run.result.error.message;
  const value = run.result?.result;
  if (typeof value === "string") {
    const structured = parseStructuredWorkflowResult(value);
    return structured === undefined ? value : formatStructuredWorkflowResult(structured);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      const structured = parseStructuredWorkflowResult(record.text);
      return structured === undefined ? record.text : formatStructuredWorkflowResult(structured);
    }
    try {
      return formatStructuredWorkflowResult(record);
    } catch {
      return "(unserializable result)";
    }
  }
  if (value === undefined) return "(no result recorded)";
  try {
    return JSON.stringify(value) ?? "(no result)";
  } catch {
    return "(unserializable result)";
  }
}

/** One-line usage summary for a run. */
function usageLine(usage: RunUsage): string {
  return scopedUsageText({
    owner: "Agent",
    iterations: usage.iterations,
    ...(usage.input_tokens === undefined ? {} : { input: usage.input_tokens }),
    ...(usage.output_tokens === undefined ? {} : { output: usage.output_tokens }),
  });
}

/**
 * The dedicated Workflow view: a list of workflows → the selected one's tree of
 * nodes (manager + leaders) → a node's run detail (result + status + usage). It
 * reads everything through the kernel's workflows/runs services, never the local
 * filesystem, so a remote kernel needs no change.
 */
export function WorkflowsHub(host: ViewHost, deps: WorkflowsHubDeps): JSX.Element {
  diagnosticCount("workflows.hub.construct");
  const dimensions = useTerminalDimensions();
  const stackedRows = (): boolean => dimensions().width < 100;
  const [rows, setRows] = createSignal<WorkflowSummary[]>([]);
  const [detail, setDetail] = createSignal<WorkflowDetail | null>(null);
  const [node, setNode] = createSignal<NodePage | null>(null);
  const [listSel, setListSel] = createSignal(0);
  const [treeSel, setTreeSel] = createSignal(0);
  const [lastUpdated, setLastUpdated] = createSignal<number>();
  const [loadError, setLoadError] = createSignal("");
  let nodeScrollEl: ScrollBoxRenderable | undefined;
  const shortIds = new Map<string, string>();
  let nextShortId = 1;
  const shortId = (value: WorkflowNode): string => {
    if (value.kind === "manager") return "Manager";
    const existing = shortIds.get(value.run_id);
    if (existing) return existing;
    const assigned = `A${nextShortId++}`;
    shortIds.set(value.run_id, assigned);
    return assigned;
  };
  const shortTitle = (value: string): string =>
    (value.split("\n").find((line) => line.trim()) ?? value).trim().replace(/\s+/g, " ");

  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  const reloadOnce = async (): Promise<void> => {
    const selectedId = selectedRow()?.execution_id;
    try {
      const page = await deps.list();
      if (disposed) return;
      setRows(page.items);
      if (selectedId) {
        const next = page.items.findIndex((item) => item.execution_id === selectedId);
        if (next >= 0) setListSel(next);
      }
      setLastUpdated(deps.now());
      setLoadError("");
    } catch (error) {
      if (!disposed) setLoadError(error instanceof Error ? error.message : String(error));
    }
  };
  const inNode = (): boolean => node() !== null;
  const inTree = (): boolean => detail() !== null && !inNode();
  const listItems = (): WorkflowSummary[] => rows();
  const mergeTreeNodes = (persisted: WorkflowNode[], executionId?: string): WorkflowNode[] => {
    const live = deps.live?.();
    if (!live || live.root !== executionId) return persisted;
    const byId = new Map(persisted.map((item) => [item.run_id, item]));
    for (const current of live.nodes.values()) {
      const old = byId.get(current.runId);
      byId.set(current.runId, {
        ...(old ?? {
          run_id: current.runId,
          kind: current.kind,
          title: current.title,
          status: "running",
        }),
        ...(current.parentRunId !== undefined ? { parent_run_id: current.parentRunId } : {}),
        ...(current.profile !== undefined ? { profile: current.profile } : {}),
        title: current.title,
        status:
          current.status === "running"
            ? "running"
            : current.status === "ok"
              ? "completed"
              : "failed",
        ...(current.startedAt !== undefined ? { started_at: current.startedAt } : {}),
        ...(current.endedAt !== undefined ? { ended_at: current.endedAt } : {}),
        ...(current.roundId !== undefined ? { round_id: current.roundId } : {}),
        ...(current.pass !== undefined ? { pass: current.pass } : {}),
        ...(current.itemIndex !== undefined ? { item_index: current.itemIndex } : {}),
        ...(current.replica !== undefined ? { replica: current.replica } : {}),
        ...(current.replicaCount !== undefined ? { replica_count: current.replicaCount } : {}),
        ...(current.error !== undefined ? { error: current.error } : {}),
        ...(current.reason !== undefined ? { reason: current.reason } : {}),
      });
    }
    return [...byId.values()].sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
  };
  const treeNodes = (): WorkflowNode[] =>
    mergeTreeNodes(detail()?.nodes ?? [], detail()?.execution_id);
  const selectedRow = (): WorkflowSummary | undefined =>
    listItems()[clampListIndex(listSel(), listItems().length)];
  const selectedNode = (): WorkflowNode | undefined =>
    treeNodes()[clampListIndex(treeSel(), treeNodes().length)];
  const nodeContent = (): string => {
    const current = node();
    if (current === null) return "";
    if (current.mode === "task") {
      return current.meta.task ?? "Task unavailable for this legacy workflow";
    }
    return resultText(current.run, current.meta);
  };
  const nodeUsage = (): RunUsage | undefined => {
    const current = node();
    return current?.mode === "result" ? current.run?.result?.usage : undefined;
  };

  let openWorkflowActive: string | undefined;
  let openWorkflowQueued: string | undefined;
  function openWorkflow(): void {
    const workflow = selectedRow();
    if (!workflow) return;
    const id = workflow.execution_id;
    if (openWorkflowActive !== undefined) {
      if (id !== openWorkflowActive) openWorkflowQueued = id;
      diagnosticCount("workflows.open.coalesced", { id });
      return;
    }
    openWorkflowActive = id;
    detachObserved("workflow_open", async () => {
      try {
        let next: string | undefined = id;
        while (next !== undefined && !disposed) {
          const requestedId = next;
          openWorkflowActive = requestedId;
          openWorkflowQueued = undefined;
          try {
            const detail = await diagnosticAsync(
              "workflows.open",
              () => deps.get(requestedId),
              deps.refreshSlowMs === undefined ? {} : { slowMs: deps.refreshSlowMs },
            );
            if (disposed) return;
            if (openWorkflowQueued === undefined) {
              setDetail(detail);
              setTreeSel(0);
              setLastUpdated(deps.now());
              setLoadError("");
            }
          } catch (error) {
            if (!disposed && openWorkflowQueued === undefined)
              setLoadError(error instanceof Error ? error.message : String(error));
          }
          next = openWorkflowQueued;
        }
      } finally {
        openWorkflowActive = undefined;
      }
    });
  }

  async function refreshTreeOnce(): Promise<void> {
    const current = detail();
    if (!current) return;
    const selectedId = selectedNode()?.run_id;
    try {
      const next = await deps.get(current.execution_id);
      if (disposed || detail()?.execution_id !== current.execution_id) return;
      setDetail(next);
      if (selectedId) {
        const index = mergeTreeNodes(next.nodes, next.execution_id).findIndex(
          (item) => item.run_id === selectedId,
        );
        if (index >= 0) setTreeSel(index);
      }
      setLastUpdated(deps.now());
      setLoadError("");
    } catch (error) {
      if (!disposed) setLoadError(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshNodeOnce(): Promise<void> {
    const current = node();
    if (current?.mode !== "result") return;
    try {
      const run = await deps.getRun(current.meta.run_id);
      if (disposed) return;
      setNode((latest) =>
        latest?.mode === "result" && latest.meta.run_id === current.meta.run_id
          ? {
              ...latest,
              run,
              meta: run === null ? latest.meta : { ...latest.meta, status: run.status },
            }
          : latest,
      );
      setLastUpdated(deps.now());
      setLoadError("");
    } catch (error) {
      if (!disposed) setLoadError(error instanceof Error ? error.message : String(error));
    }
  }

  type RefreshTarget = "list" | "tree" | "node";
  let refreshActive = false;
  let refreshQueued = false;
  let queuedTarget: RefreshTarget = "list";
  const currentRefreshTarget = (): RefreshTarget =>
    inNode() ? "node" : inTree() ? "tree" : "list";
  const refreshOnce = (target: RefreshTarget): Promise<void> =>
    target === "node" ? refreshNodeOnce() : target === "tree" ? refreshTreeOnce() : reloadOnce();
  const requestRefresh = (target: RefreshTarget = currentRefreshTarget()): void => {
    if (disposed) return;
    queuedTarget = target;
    diagnosticCount(
      "workflows.refresh.requested",
      { target },
      `workflows.refresh.requested.${target}`,
    );
    if (refreshActive) {
      refreshQueued = true;
      diagnosticCount(
        "workflows.refresh.coalesced",
        { target },
        `workflows.refresh.coalesced.${target}`,
      );
      return;
    }
    refreshActive = true;
    detachObserved("workflow_refresh", async () => {
      try {
        do {
          refreshQueued = false;
          const next = queuedTarget;
          await diagnosticAsync(`workflows.refresh.${next}`, () => refreshOnce(next), {
            ...(deps.refreshSlowMs === undefined ? {} : { slowMs: deps.refreshSlowMs }),
            onSlow: () => {
              if (!disposed)
                setLoadError("Refresh is still pending; the backend may be unavailable");
            },
          });
        } while (refreshQueued && !disposed);
      } finally {
        refreshActive = false;
      }
    });
  };
  const reload = (): void => requestRefresh("list");
  const refreshTree = (): void => requestRefresh("tree");
  const refreshNode = (): void => requestRefresh("node");
  onMount(reload);

  let openNodeActive: string | undefined;
  function openNode(): void {
    const meta = selectedNode();
    if (!meta) return;
    if (openNodeActive !== undefined) {
      diagnosticCount("workflows.node-open.coalesced", { id: meta.run_id });
      return;
    }
    openNodeActive = meta.run_id;
    setNode({ mode: "result", meta, run: null });
    detachObserved("workflow_node_open", async () => {
      try {
        const run = await diagnosticAsync(
          "workflows.node-open",
          () => deps.getRun(meta.run_id),
          deps.refreshSlowMs === undefined ? {} : { slowMs: deps.refreshSlowMs },
        );
        if (disposed) return;
        setNode((current) =>
          current?.mode === "result" && current.meta.run_id === meta.run_id
            ? { ...current, run }
            : current,
        );
        setLastUpdated(deps.now());
        setLoadError("");
      } catch (error) {
        if (!disposed) setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        openNodeActive = undefined;
      }
    });
  }

  function openTask(): void {
    const meta = selectedNode();
    if (meta?.kind !== "leader" || meta.task === undefined) return;
    setNode({ mode: "task", meta });
  }

  const backToList = (): void => {
    setDetail(null);
    reload();
  };
  const backToTree = (): void => {
    setNode(null);
    refreshTree();
  };

  createEffect(() => {
    if (!host.active()) return;
    const running = inNode()
      ? node()?.meta.status === "running"
      : inTree()
        ? detail()?.status === "running"
        : rows().some((item) => item.status === "running");
    if (!running) return;
    const timer = setInterval(() => {
      if (inNode()) refreshNode();
      else if (inTree()) refreshTree();
      else reload();
    }, deps.pollMs ?? 1_000);
    onCleanup(() => clearInterval(timer));
  });

  function requestDelete(): void {
    const workflow = selectedRow();
    if (!workflow || !deps.delete) return;
    detachObserved("workflow_delete_confirm", () =>
      host
        .confirm({
          message: `delete workflow '${workflow.title ?? workflow.execution_id}'?`,
          danger: true,
          confirmLabel: "delete",
          cancelLabel: "keep",
        })
        .then((ok) => {
          if (ok)
            detachObserved("workflow_delete", () =>
              deps.delete!(workflow.execution_id).then(reload),
            );
        }),
    );
  }

  const spec = (): LevelSpec => {
    if (inNode()) {
      return {
        scroll: () => nodeScrollEl,
        verbs: [{ key: "r", label: "refresh", run: refreshNode }],
        escape: { label: "back", run: backToTree },
      };
    }
    if (inTree()) {
      if (treeNodes().length === 0)
        return {
          verbs: [{ key: "r", label: "refresh", run: refreshTree }],
          escape: { label: "back", run: backToList },
        };
      return {
        nav: {
          count: () => treeNodes().length,
          index: treeSel,
          setIndex: setTreeSel,
          activate: { label: "open", run: openNode },
        },
        verbs: [
          { key: "r", label: "refresh", run: refreshTree },
          {
            id: "ui.workflow.task.open",
            key: "t",
            label: "open task",
            run: openTask,
            when: () => selectedNode()?.kind === "leader" && selectedNode()?.task !== undefined,
            category: "navigation",
            hintGroup: "navigation",
            essential: true,
          },
        ],
        escape: { label: "back", run: backToList },
      };
    }
    if (listItems().length === 0)
      return {
        verbs: [
          { key: "r", label: "refresh", run: reload },
          ...(deps.openAgentPicker
            ? [{ key: "a", label: "choose agent", run: deps.openAgentPicker }]
            : []),
        ],
      };
    return {
      nav: {
        count: () => listItems().length,
        index: listSel,
        setIndex: setListSel,
        activate: { label: "open", run: openWorkflow },
      },
      verbs: [
        { key: "r", label: "refresh", run: reload },
        ...(deps.delete && selectedRow()
          ? [{ key: "d", label: "delete", run: requestDelete }]
          : []),
      ],
    };
  };

  bindLevelKeys({
    host,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  const title = (): string => {
    if (inNode()) {
      const current = node()!.meta;
      const page = node()!.mode === "task" ? "Task" : "Result";
      return `Workflows ${glyph("chevronRight")} ${shortTitle(detail()?.title ?? "")} ${glyph("chevronRight")} ${shortId(current)} ${glyph("separator")} ${shortTitle(current.title)} ${glyph("chevronRight")} ${page}`;
    }
    if (inTree()) return `Workflows ${glyph("chevronRight")} ${shortTitle(detail()?.title ?? "")}`;
    return "Workflows";
  };

  const roundContext = (value: WorkflowNode): string => {
    if (value.round_id === undefined) return value.profile ?? value.kind;
    const pass = value.pass === undefined ? "" : ` ${glyph("separator")} pass ${value.pass + 1}`;
    const item =
      value.item_index === undefined ? "" : ` ${glyph("separator")} item ${value.item_index + 1}`;
    const replica =
      value.replica === undefined
        ? ""
        : ` ${glyph("separator")} replica ${value.replica + 1}/${value.replica_count ?? "?"}`;
    return `round ${value.round_id}${pass}${item}${replica}`;
  };

  return (
    <ViewFrame
      host={host}
      title={title()}
      mode="monitor"
      purpose="Live workflow state; open an agent's result or full task"
    >
      <Show when={loadError()}>
        <text flexShrink={0} fg={tokens.del} wrapMode="word">
          {`Refresh failed: ${loadError()}`}
        </text>
      </Show>
      <Show when={lastUpdated()}>
        <text flexShrink={0} fg={tokens.muted}>
          {`Updated ${relTime(lastUpdated()!, deps.now())}`}
        </text>
      </Show>
      <Show when={inNode()}>
        <text flexShrink={0} fg={tokens.muted} paddingBottom={1}>
          {`${shortId(node()!.meta)} ${glyph("separator")} ${node()?.meta.profile ?? node()?.meta.kind ?? "agent"} ${glyph("separator")} ${lifecycleLabel(uiLifecycle(node()?.meta.status ?? "waiting"))}`}
        </text>
        <Show when={node()?.meta.error ?? node()?.meta.reason}>
          <text flexShrink={0} fg={tokens.del} wrapMode="word">
            {node()?.meta.error?.message ?? node()?.meta.reason}
          </text>
        </Show>
        <scrollbox
          ref={(el: ScrollBoxRenderable) => (nodeScrollEl = el)}
          flexGrow={1}
          flexBasis={0}
          minHeight={0}
          paddingRight={SCROLLBOX_TABLE_GUTTER}
          verticalScrollbarOptions={scrollbarOptions()}
        >
          <Prose block content={nodeContent()} />
        </scrollbox>
        <Show when={nodeUsage()} keyed>
          {(usage: RunUsage) => (
            <text flexShrink={0} fg={tokens.muted} paddingTop={1}>
              {usageLine(usage)}
            </text>
          )}
        </Show>
      </Show>

      <Show when={inTree()}>
        <Show when={detail()?.sequence}>
          {(sequence: Accessor<WorkflowSequence>) => (
            <text
              flexShrink={0}
              fg={sequence().status === "awaiting_manager" ? tokens.warn : tokens.muted}
            >
              {sequence().status === "awaiting_manager"
                ? `Awaiting Admiral ${glyph("separator")} revision ${sequence().revision} ${glyph("separator")} next ${sequence().next_round_id ?? "round"}`
                : `${sequence().status} ${glyph("separator")} ${sequence().round_id ?? sequence().session_id} ${glyph("separator")} leaders ${sequence().leaders_started}/${sequence().max_total_leaders}`}
            </text>
          )}
        </Show>
        <SelectableList<WorkflowNode>
          each={treeNodes}
          sel={treeSel}
          idPrefix="workflow-node-"
          empty={() => ({
            text: "no nodes",
            icon: "info",
            hint: "the manager has not spawned agents",
          })}
          contentRows={() => treeNodes().length * (stackedRows() ? 2 : 1)}
          row={(treeNode, i) => (
            <Show
              when={!stackedRows()}
              fallback={
                <box flexDirection="column" flexShrink={0}>
                  <SelectableRow selected={treeSel() === i()}>
                    <span
                      style={{ fg: treeNode.kind === "manager" ? tokens.accent : tokens.fg }}
                    >{`${glyphFor(treeNode.kind)} ${shortId(treeNode)}  ${shortTitle(treeNode.title)}`}</span>
                  </SelectableRow>
                  <text height={1} paddingLeft={4} wrapMode="none" truncate>
                    <span style={{ fg: tokens.muted }}>{roundContext(treeNode)}</span>
                    <span style={{ fg: statusColor(treeNode.status) }}>
                      {` ${glyph("separator")} ${lifecycleLabel(uiLifecycle(treeNode.status))}`}
                    </span>
                  </text>
                </box>
              }
            >
              <PickerRow
                selected={treeSel() === i()}
                base={tokens.bg}
                cells={[
                  {
                    width: 12,
                    text: `${glyphFor(treeNode.kind)} ${shortId(treeNode)}`,
                    fg: treeNode.kind === "manager" ? tokens.accent : tokens.fg,
                  },
                  { grow: true, text: shortTitle(treeNode.title), fg: tokens.fg },
                  {
                    width: 18,
                    shrink: true,
                    text: roundContext(treeNode),
                    fg: tokens.muted,
                  },
                  {
                    width: 14,
                    text: lifecycleLabel(uiLifecycle(treeNode.status)),
                    fg: statusColor(treeNode.status),
                  },
                ]}
              />
            </Show>
          )}
        />
      </Show>

      <Show when={!inTree() && !inNode()}>
        <SelectableList<WorkflowSummary>
          each={listItems}
          sel={listSel}
          idPrefix="workflow-"
          empty={() => ({
            text: "no workflows yet",
            icon: "info",
            hint: "choose a workflow-enabled agent, then start a task",
          })}
          contentRows={() => listItems().length * (stackedRows() ? 2 : 1)}
          row={(workflow, i) => (
            <Show
              when={!stackedRows()}
              fallback={
                <box flexDirection="column" flexShrink={0}>
                  <SelectableRow selected={listSel() === i()}>
                    <span style={{ fg: tokens.fg }}>{workflow.title || workflow.execution_id}</span>
                  </SelectableRow>
                  <text height={1} paddingLeft={4} fg={tokens.muted} wrapMode="none" truncate>
                    {`${workflow.leader_count} agents ${glyph("separator")} ${lifecycleLabel(uiLifecycle(workflow.status))} ${glyph("separator")} ${relTime(workflow.updated_at, deps.now())}`}
                  </text>
                </box>
              }
            >
              <PickerRow
                selected={listSel() === i()}
                base={tokens.bg}
                cells={[
                  {
                    grow: true,
                    text: workflow.title || workflow.execution_id,
                    fg: tokens.fg,
                  },
                  { width: 12, text: `${workflow.leader_count} agents`, fg: tokens.muted },
                  {
                    width: 14,
                    text: lifecycleLabel(uiLifecycle(workflow.status)),
                    fg: statusColor(workflow.status),
                  },
                  { width: 10, text: relTime(workflow.updated_at, deps.now()), fg: tokens.muted },
                ]}
              />
            </Show>
          )}
        />
      </Show>
    </ViewFrame>
  );
}
