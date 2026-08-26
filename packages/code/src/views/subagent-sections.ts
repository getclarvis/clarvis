import type { NodeStatus, TranscriptNode } from "../adapters/store.ts";

/** The summary row rendered above a folded sub-agent section (or a lead's own step counter). */
export interface SectionHeader {
  order: number;
  title: string;
  model?: string;
  status: NodeStatus;
  hiddenEntries?: number;
  toolCalls?: number;
  lead?: boolean;
}

const LEAD_KINDS = new Set<TranscriptNode["kind"]>([
  "assistant",
  "reasoning",
  "thinking",
  "tool_call",
  "error",
]);

/** The transcript re-laid-out into lead nodes and per-sub-agent sections, as computed by {@link computeGroupedNodes}. */
export interface GroupedTranscript {
  ordered: TranscriptNode[];
  headers: Map<string, SectionHeader>;
  folded: Set<string>;
  anchors: Map<string, string>;
}

function runIdOf(node: TranscriptNode): string {
  const i = node.key.indexOf("::");
  return i >= 0 ? node.key.slice(0, i) : "";
}

/**
 * Groups a flat transcript into lead-run nodes and contiguous per-sub-agent
 * sections, ready for folded rendering.
 *
 * @remarks
 * Nodes belonging to the same sub-agent invocation (matched by run id +
 * `subagentOrder`) are bucketed into one section, keyed off its `subagent`
 * card when present (else its first body node). A section's body folds behind
 * the card even when the lead produced no visible transcript; otherwise
 * parallel workers all expand into an initially empty transcript. A degraded
 * section without a card and without visible Lead context keeps its first body
 * node as the visible identity anchor and folds any remaining entries behind
 * it; with Lead context, the whole degraded body folds as before.
 * Sections are emitted in flush order: finished sections first, then running
 * ones, each ordered by `subagentOrder` — so a completed sub-agent never
 * jumps position once a sibling starts running. A lead node only gets a
 * `SectionHeader` (with `lead: true`) when it actually did work (tool calls
 * or reasoning) before its first sub-agent spawn, so a lead with nothing to
 * show never renders an empty step counter.
 */
export function computeGroupedNodes(
  nodes: readonly TranscriptNode[],
  statusBySubagentId: ReadonlyMap<string, NodeStatus> = new Map(),
): GroupedTranscript {
  type Slot = { section: string } | { lead: TranscriptNode };
  const layout: Slot[] = [];
  const buckets = new Map<string, TranscriptNode[]>();

  const leadFirst = new Map<string, string>();
  const leadToolCalls = new Map<string, number>();
  const leadHasWork = new Set<string>();
  const leadModel = new Map<string, string>();
  const runStatus = new Map<string, NodeStatus>();
  for (const node of nodes) {
    if (node.kind === "run") {
      runStatus.set(runIdOf(node), node.status);
      continue;
    }
    if (node.subagentOrder !== undefined || !LEAD_KINDS.has(node.kind)) continue;
    if (node.key.startsWith("local:")) continue;
    const rid = runIdOf(node);
    if (!leadFirst.has(rid)) leadFirst.set(rid, node.key);
    if (node.kind === "tool_call") {
      leadToolCalls.set(rid, (leadToolCalls.get(rid) ?? 0) + 1);
      leadHasWork.add(rid);
    }
    if (node.kind === "reasoning") leadHasWork.add(rid);
    if (node.model && !leadModel.has(rid)) leadModel.set(rid, node.model);
  }

  for (const node of nodes) {
    if (node.subagentOrder === undefined) {
      layout.push({ lead: node });
      continue;
    }
    const sectionKey = `${runIdOf(node)}:${node.subagentOrder}`;
    let bucket = buckets.get(sectionKey);
    if (!bucket) {
      bucket = [];
      buckets.set(sectionKey, bucket);
      layout.push({ section: sectionKey });
    }
    bucket.push(node);
  }

  const ordered: TranscriptNode[] = [];
  const headers = new Map<string, SectionHeader>();
  const folded = new Set<string>();
  const anchors = new Map<string, string>();

  const rosterStatus = (bucket: readonly TranscriptNode[]): NodeStatus | undefined => {
    for (const node of bucket) {
      if (node.subagentId === undefined) continue;
      const status = statusBySubagentId.get(node.subagentId);
      if (status !== undefined) return status;
    }
    return undefined;
  };

  const emitSection = (sectionKey: string): void => {
    const bucket = buckets.get(sectionKey)!;
    const card = bucket.find((n) => n.kind === "subagent");
    const body = bucket.filter((n) => n.kind !== "subagent");
    const head = body[0];
    if (!head) {
      if (card) {
        headers.set(card.key, {
          order: card.subagentOrder ?? 0,
          title: card.title ?? "subagent",
          model: card.model,
          status: rosterStatus(bucket) ?? card.status,
        });
        ordered.push(card);
      }
      return;
    }
    const anchor = card ?? head;
    const status: NodeStatus = rosterStatus(bucket) ?? card?.status ?? "running";
    const cardlessAnchorOnly = card === undefined && !leadFirst.has(runIdOf(head));
    const foldedBody = cardlessAnchorOnly ? body.slice(1) : body;
    for (const n of foldedBody) {
      folded.add(n.key);
      anchors.set(n.key, anchor.key);
    }
    const hiddenEntries = foldedBody.length;
    headers.set(anchor.key, {
      order: anchor.subagentOrder ?? 0,
      title: card?.title ?? head.agentLabel ?? "subagent",
      model: card?.model ?? body.find((n) => n.model)?.model,
      status,
      ...(hiddenEntries > 0 ? { hiddenEntries } : {}),
    });
    if (card) ordered.push(card);
    for (const n of body) ordered.push(n);
  };

  const sectionOf = (sectionKey: string): { order: number; active: boolean } => {
    const bucket = buckets.get(sectionKey)!;
    const card = bucket.find((n) => n.kind === "subagent");
    return {
      order: bucket[0]?.subagentOrder ?? 0,
      active: (rosterStatus(bucket) ?? card?.status ?? "running") === "running",
    };
  };

  let pending: string[] = [];
  const flush = (): void => {
    pending.sort((a, b) => {
      const sa = sectionOf(a);
      const sb = sectionOf(b);
      if (sa.active !== sb.active) return sa.active ? 1 : -1;
      return sa.order - sb.order;
    });
    for (const key of pending) emitSection(key);
    pending = [];
  };

  for (const slot of layout) {
    if ("lead" in slot) {
      flush();
      const node = slot.lead;
      const rid = runIdOf(node);
      if (leadHasWork.has(rid) && leadFirst.get(rid) === node.key) {
        headers.set(node.key, {
          order: -1,
          title: "",
          lead: true,
          model: leadModel.get(rid),
          status: runStatus.get(rid) ?? "running",
          toolCalls: leadToolCalls.get(rid) ?? 0,
        });
      }
      ordered.push(node);
      continue;
    }
    pending.push(slot.section);
  }
  flush();

  return { ordered, headers, folded, anchors };
}
