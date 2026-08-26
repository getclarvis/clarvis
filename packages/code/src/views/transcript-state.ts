import type { Accessor } from "solid-js";
import { createEffect, createMemo, createSignal, on } from "solid-js";
import type { NodeStatus, TranscriptNode, TranscriptToolNode } from "../adapters/store.ts";
import { subagentFocusToast } from "../core/transcript/index.ts";
import { toolIdentity } from "../adapters/tool-identity.ts";
import { computeGroupedNodes, type GroupedTranscript } from "./subagent-sections.ts";
import { computeToolGroups, type ToolGroupInfo } from "./tool-groups.ts";
import {
  computeFocusables,
  isFoldedAway,
  nextFocus,
  toggleOverride,
  type BlockOverride,
} from "./block-focus.ts";
import {
  createTranscriptTurnIndex,
  NO_TRANSCRIPT_TURNS,
  windowTranscriptIndexed,
  type TranscriptWindow,
} from "./transcript-window.ts";

const DIFF_TOOLS = new Set([
  "apply_patch",
  "edit_file",
  "multi_edit",
  "write_file",
  "diff",
  "replace",
]);

/**
 * Host-provided data and callbacks {@link createTranscriptState} reads and
 * drives its derived state from.
 */
export interface TranscriptStateDeps {
  nodes: () => readonly TranscriptNode[];
  subagents: () => readonly { id: string; order: number; title: string; status?: NodeStatus }[];
  notify: (message: string) => void;
  defaultFolded?: (key: string) => boolean;
  /**
   * Refills a tool block whose body the transcript's retention window dropped.
   *
   * @remarks Called on every toggle, not only on expands: the block may be
   *   opening or closing and the store no-ops on a node that still has its body,
   *   so deciding here would only duplicate that check against a fold state this
   *   function is in the middle of changing.
   */
  rehydrate?: (key: string) => void;
}

/**
 * Reactive transcript view-state: grouping, folding, focus and sub-agent
 * isolation, as produced by {@link createTranscriptState}.
 */
export interface TranscriptState {
  grouped: Accessor<GroupedTranscript>;
  toolGroups: Accessor<Map<string, ToolGroupInfo>>;
  /** What the transcript currently renders, and what it is holding back. */
  window: Accessor<TranscriptWindow>;
  /**
   * Replace the current page with the next older page.
   *
   * @returns `false` when the window already reaches the start of the
   *   transcript, so the caller can say so rather than appearing to do nothing.
   */
  loadEarlier(): boolean;
  /** Replace the current page with the next newer page. */
  loadLater(): boolean;
  expandAll: Accessor<boolean>;
  selectedSubagent: Accessor<string | null>;
  focusedKey: Accessor<string | null>;
  folded(key: string): boolean;
  overrideOf(key: string): BlockOverride | undefined;
  toggleAt(key: string): void;
  reset(): void;
  /** Selects `id`'s isolated view, or clears the selection if `id` is already selected. */
  toggleSubagent(id: string): void;
  cycleSubagent(): void;
  toggleExpandOrBlock(): void;
  focusBlock(delta: number): string | null;
  clearFocus(): boolean;
  pickDiffNode(): TranscriptToolNode | null;
}

/**
 * Builds the transcript's reactive view-state: node grouping, tool-call
 * grouping, fold/expand overrides, block focus and sub-agent isolation.
 *
 * @param deps - {@link TranscriptStateDeps} the state derives from and
 * reports through.
 * @returns The {@link TranscriptState} handle exposing derived accessors and
 * the actions that mutate them.
 */
/**
 * Moves each run's terminal marker after the last node belonging to that run.
 *
 * @param nodes - the transcript in arrival order.
 * @returns the same nodes, with every `<exec>::run` node placed after the last
 *   node sharing its `<exec>` prefix. Returns the input untouched when nothing
 *   moves, so the common case allocates nothing.
 * @remarks A run's `run` node is created when `run_ended` arrives, but events
 * for work that had *already finished* can still land after it — most visibly
 * on a cancellation, where a tool call proven by the engine's own trace
 * timestamps to have completed *before* the cancel rendered *below* the
 * `Canceled` marker. A run's outcome is the last thing that happened to it and
 * must read last.
 *
 * This is done as a projection rather than in the store on purpose: the store
 * guarantees node identity across a reconcile so the renderer never remounts a
 * run (`run-end-reconcile.test.ts` asserts it with `toBe`), and moving nodes
 * there breaks that guarantee. Reordering a read-only view costs nothing and
 * risks nothing.
 */
export function withRunMarkersLast(nodes: readonly TranscriptNode[]): readonly TranscriptNode[] {
  const lastOfRun = new Map<string, number>();
  const markerAt = new Map<string, number>();
  for (const [index, node] of nodes.entries()) {
    const separator = node.key.indexOf("::");
    if (separator <= 0) continue;
    const exec = node.key.slice(0, separator);
    lastOfRun.set(exec, index);
    if (node.key === `${exec}::run`) markerAt.set(exec, index);
  }
  const moving = [...markerAt].filter(([exec, at]) => (lastOfRun.get(exec) ?? at) > at);
  if (moving.length === 0) return nodes;
  const displaced = new Set(moving.map(([, at]) => at));
  const insertAfter = new Map<number, TranscriptNode>();
  for (const [exec, at] of moving) insertAfter.set(lastOfRun.get(exec)!, nodes[at]!);
  const out: TranscriptNode[] = [];
  for (const [index, node] of nodes.entries()) {
    if (!displaced.has(index)) out.push(node);
    const trailing = insertAfter.get(index);
    if (trailing !== undefined) out.push(trailing);
  }
  return out;
}

export function createTranscriptState(deps: TranscriptStateDeps): TranscriptState {
  const [expandAll, setExpandAll] = createSignal(false);
  const [selectedSubagent, setSelectedSubagent] = createSignal<string | null>(null);
  const [focusedKey, setFocusedKey] = createSignal<string | null>(null);
  const [overrides, setOverrides] = createSignal<ReadonlyMap<string, BlockOverride>>(new Map());
  const [pageEnd, setPageEnd] = createSignal<number | null>(null);
  const [laterPageEnds, setLaterPageEnds] = createSignal<readonly number[]>([]);
  const turnIndex = createTranscriptTurnIndex();

  const visibleNodes = createMemo(() => {
    const sel = selectedSubagent();
    const base = deps.nodes();
    const scoped = sel === null ? base : base.filter((n) => n.subagentId === sel);
    return withRunMarkersLast(scoped);
  });
  /**
   * The rendered slice of the transcript.
   *
   * @remarks Windowing happens **here**, ahead of {@link computeGroupedNodes},
   *   rather than by slicing `grouped().ordered` afterwards. Everything
   *   downstream reads adjacency or resolves a key: `computeToolGroups` assigns
   *   `head`/`member` by adjacency, so a head left outside the slice would hide
   *   its own visible members; `isFoldedAway` resolves a section anchor that
   *   would no longer be there; and `computeFocusables` would hand out focus on
   *   keys that are not mounted. Cutting the nodes first means all of it derives
   *   from exactly what is rendered.
   */
  const window_ = createMemo(() =>
    windowTranscriptIndexed(
      visibleNodes(),
      pageEnd(),
      selectedSubagent() === null ? turnIndex : NO_TRANSCRIPT_TURNS,
    ),
  );
  const grouped = createMemo(() =>
    computeGroupedNodes(
      window_().nodes,
      new Map(
        deps
          .subagents()
          .filter((agent) => agent.status !== undefined)
          .map((agent) => [agent.id, agent.status!] as const),
      ),
    ),
  );
  const toolGroups = createMemo(() => computeToolGroups(grouped().ordered));
  const focusables = createMemo(() => computeFocusables(grouped(), toolGroups(), overrides()));

  createEffect(() => {
    const sel = selectedSubagent();
    if (sel !== null && !deps.subagents().some((w) => w.id === sel)) setSelectedSubagent(null);
  });

  createEffect(
    on(
      selectedSubagent,
      () => {
        setPageEnd(null);
        setLaterPageEnds([]);
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    const key = focusedKey();
    if (key !== null && !focusables().includes(key)) setFocusedKey(null);
  });

  function toggleBlock(key: string): void {
    deps.rehydrate?.(key);
    setOverrides(
      toggleOverride({
        key,
        g: grouped(),
        groups: toolGroups(),
        node: deps.nodes().find((n) => n.key === key),
        defaultFolded: deps.defaultFolded ?? (() => false),
        expandAll: expandAll(),
        overrides: overrides(),
      }),
    );
  }

  return {
    grouped,
    toolGroups,
    window: window_,
    loadEarlier: () => {
      const w = window_();
      if (w.atStart) return false;
      setLaterPageEnds((ends) => [...ends, w.end]);
      setPageEnd(w.start);
      return true;
    },
    loadLater: () => {
      const w = window_();
      if (w.atEnd) return false;
      const ends = laterPageEnds();
      const next = ends[ends.length - 1];
      setLaterPageEnds(ends.slice(0, -1));
      setPageEnd(next === undefined || next >= visibleNodes().length ? null : next);
      return true;
    },
    expandAll,
    selectedSubagent,
    focusedKey,
    folded: (key) => selectedSubagent() === null && isFoldedAway(grouped(), key, overrides()),
    overrideOf: (key) => overrides().get(key),
    toggleAt: (key) => {
      setFocusedKey(key);
      toggleBlock(key);
    },
    reset: () => {
      setFocusedKey(null);
      setOverrides(new Map());
      setPageEnd(null);
      setLaterPageEnds([]);
    },
    toggleSubagent: (id) => {
      if (selectedSubagent() === id) {
        setSelectedSubagent(null);
        deps.notify("showing all activity");
        return;
      }
      setSelectedSubagent(id);
      const w = deps.subagents().find((x) => x.id === id);
      deps.notify(subagentFocusToast(w ? w.title : id));
    },
    cycleSubagent: () => {
      const subagents = [...deps.subagents()].sort((a, b) => a.order - b.order);
      if (subagents.length === 0) {
        setSelectedSubagent(null);
        deps.notify("no sub-agents to focus");
        return;
      }
      const cur = selectedSubagent();
      const idx = cur === null ? -1 : subagents.findIndex((w) => w.id === cur);
      const next = idx + 1 >= subagents.length ? null : subagents[idx + 1]!.id;
      setSelectedSubagent(next);
      if (next === null) deps.notify("showing all activity");
      else {
        const w = subagents.find((x) => x.id === next);
        deps.notify(subagentFocusToast(w ? w.title : next));
      }
    },
    toggleExpandOrBlock: () => {
      const key = focusedKey();
      if (key) {
        toggleBlock(key);
        return;
      }
      setExpandAll((e) => !e);
      deps.notify(expandAll() ? "blocks expanded" : "");
    },
    focusBlock: (delta) => {
      const next = nextFocus(focusables(), focusedKey(), delta);
      if (next === null) {
        deps.notify("nothing to focus");
        return null;
      }
      setFocusedKey(next);
      return next;
    },
    clearFocus: () => {
      if (focusedKey() === null) return false;
      setFocusedKey(null);
      return true;
    },
    pickDiffNode: () => {
      const isDiffTool = (n: TranscriptNode): n is TranscriptToolNode =>
        n.kind === "tool_call" && DIFF_TOOLS.has(toolIdentity(n.mcpName, n.toolName));
      /**
       * The diff overlay reads the node's `diff` reactively, so a block whose
       * body the retention window dropped is asked to refill and returned
       * anyway — the viewer fills in when the fetch lands. Skipping it instead
       * would silently open some older diff than the one the user selected.
       */
      const chosen = (n: TranscriptToolNode): TranscriptToolNode => {
        if (n.dehydrated === true) deps.rehydrate?.(n.key);
        return n;
      };
      const nodes = deps.nodes();
      const focusedNode = nodes.find((n) => n.key === focusedKey());
      if (focusedNode && isDiffTool(focusedNode)) return chosen(focusedNode);
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const n = nodes[i];
        if (n && isDiffTool(n)) return chosen(n);
      }
      return null;
    },
  };
}
