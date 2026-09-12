import type { Accessor } from "solid-js";
import { createEffect, createMemo, createSignal } from "solid-js";
import type { NodeStatus, TranscriptNode, TranscriptToolNode } from "../adapters/store.ts";
import { subagentFocusToast } from "../core/transcript/index.ts";
import { toolIdentity } from "../adapters/tool-identity.ts";
import { nextFocus, type BlockOverride } from "./block-focus.ts";

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
  /** Mutable/detail source used only by explicit overlays, never by committed history rendering. */
  detailNodes?: () => readonly TranscriptNode[];
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
  /** Connect the production row projection to keyboard focus and explicit expansion. */
  bindRows(rows: {
    ids: Accessor<readonly string[]>;
    destination: (key: string) => string | undefined;
    defaultFolded: (key: string) => boolean;
  }): void;
  /** Lead-only main projection, or one explicitly selected sub-agent transcript. */
  semanticNodes: Accessor<readonly TranscriptNode[]>;
  expandAll: Accessor<boolean>;
  selectedSubagent: Accessor<string | null>;
  focusedKey: Accessor<string | null>;
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

/** External row-keyed expansion and focus survive unmounting and projection navigation. */
export function createTranscriptState(deps: TranscriptStateDeps): TranscriptState {
  const [rowBinding, setRowBinding] = createSignal<{
    ids: Accessor<readonly string[]>;
    destination: (key: string) => string | undefined;
    defaultFolded: (key: string) => boolean;
  }>();
  const [expandAll, setExpandAll] = createSignal(false);
  const [selectedSubagent, setSelectedSubagent] = createSignal<string | null>(null);
  const [focusedKey, setFocusedKey] = createSignal<string | null>(null);
  const focusedByProjection = new Map<string | null, string | null>();
  const selectProjection = (next: string | null): void => {
    focusedByProjection.set(selectedSubagent(), focusedKey());
    setSelectedSubagent(next);
    setFocusedKey(focusedByProjection.get(next) ?? null);
  };
  const [overrides, setOverrides] = createSignal<ReadonlyMap<string, BlockOverride>>(new Map());

  const visibleNodes = createMemo(() => {
    const sel = selectedSubagent();
    const base = deps.nodes();
    const scoped =
      sel === null
        ? base.some((node) => node.subagentId !== undefined || node.subagentOrder !== undefined)
          ? base.filter((node) => node.subagentId === undefined && node.subagentOrder === undefined)
          : base
        : base.filter((node) => node.subagentId === sel);
    return scoped;
  });

  createEffect(() => {
    const semanticKeys = new Set([
      ...deps.nodes().flatMap((node) => [node.key, `exploration:${node.key}`]),
      ...(rowBinding()?.ids() ?? []),
    ]);
    for (const [projection, key] of focusedByProjection)
      if (key !== null && !semanticKeys.has(key)) focusedByProjection.delete(projection);

    const current = overrides();
    if (current.size === 0) return;
    if ([...current.keys()].every((key) => semanticKeys.has(key))) return;
    setOverrides(new Map([...current].filter(([key]) => semanticKeys.has(key))));
  });

  const focusables = createMemo(() => [...(rowBinding()?.ids() ?? [])]);

  createEffect(() => {
    const sel = selectedSubagent();
    if (
      sel !== null &&
      !deps.subagents().some((w) => w.id === sel) &&
      !deps.nodes().some((node) => node.subagentId === sel)
    )
      selectProjection(null);
  });

  createEffect(() => {
    const key = focusedKey();
    if (key !== null && !focusables().includes(key)) setFocusedKey(null);
  });

  function toggleBlock(key: string): void {
    const target = deps.nodes().find((node) => node.key === key)?.delegationTarget;
    if (target !== undefined) {
      selectProjection(target);
      return;
    }
    deps.rehydrate?.(key);
    const rows = rowBinding();
    const own = overrides().get(key);
    const defaultFolded = rows?.defaultFolded(key) ?? deps.defaultFolded?.(key) ?? false;
    const expanded = own === "expanded" || (own !== "collapsed" && (expandAll() || !defaultFolded));
    setOverrides(new Map(overrides()).set(key, expanded ? "collapsed" : "expanded"));
  }

  return {
    bindRows: setRowBinding,
    semanticNodes: visibleNodes,
    expandAll,
    selectedSubagent,
    focusedKey,
    overrideOf: (key) => overrides().get(key),
    toggleAt: (key) => {
      setFocusedKey(key);
      toggleBlock(key);
    },
    reset: () => {
      focusedByProjection.clear();
      setFocusedKey(null);
      setOverrides(new Map());
    },
    toggleSubagent: (id) => {
      if (selectedSubagent() === id) {
        selectProjection(null);
        deps.notify("showing Lead transcript");
        return;
      }
      selectProjection(id);
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
      selectProjection(next);
      if (next === null) deps.notify("showing Lead transcript");
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
      const source = deps.detailNodes?.() ?? deps.nodes();
      const selected = selectedSubagent();
      const nodes =
        selected === null
          ? source.filter(
              (node) => node.subagentId === undefined && node.subagentOrder === undefined,
            )
          : source.filter((node) => node.subagentId === selected);
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
