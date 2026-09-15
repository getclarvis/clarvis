import { createMemo, type Accessor } from "solid-js";
import type { TranscriptNode, TranscriptStore } from "./store.ts";
import { toolIdentity } from "./tool-identity.ts";
import { isExplorationTool, TranscriptRows } from "../core/transcript/rows.ts";

/** Framework adapter: publishes stable row IDs and resolves each record independently. */
export function createTranscriptProjection(
  store: TranscriptStore,
  selected: Accessor<string | null>,
) {
  const rows = new TranscriptRows();
  const records = createMemo(() => {
    const result = new Map<string, TranscriptNode>();
    for (const node of store.nodes) result.set(node.key, node);
    for (const node of store.committedNodes()) result.set(node.key, node);
    return result;
  });
  const projectionOf = (node: TranscriptNode): string =>
    node.subagentId === undefined
      ? "lead"
      : JSON.stringify([node.key.split("::")[0], node.subagentId]);
  const projectionId = createMemo(() => {
    const actor = selected();
    if (actor === null) return "lead";
    const node = [...records().values()].find((entry) => entry.subagentId === actor);
    return node === undefined ? JSON.stringify(["pending", actor]) : projectionOf(node);
  });
  const revision = createMemo(() => {
    const all = records();
    const sealed = new Set(store.committedNodes().map((node) => node.key));
    rows.retain(new Set(all.keys()));
    const before = new Map<string, string>();
    const nextByProjection = new Map<string, string>();
    for (const node of [...all.values()].reverse()) {
      const owner = projectionOf(node);
      const existing = rows.destination(node.key);
      if (existing !== undefined) nextByProjection.set(owner, existing);
      else {
        const next = nextByProjection.get(owner);
        if (next !== undefined) before.set(node.key, next);
      }
    }
    for (const node of all.values()) {
      const suppressed =
        node.kind === "plan" ||
        node.kind === "thinking" ||
        (node.kind === "run" && !sealed.has(node.key)) ||
        (node.kind === "annotation" && (node.status === "pending" || node.status === "running"));
      rows.admit({
        id: node.key,
        projection: projectionOf(node),
        scope: node.transcriptScope ?? node.key.split("::")[0]!,
        before: before.get(node.key),
        kind: suppressed
          ? "boundary"
          : node.kind === "tool_call" &&
              !node.attributionIncomplete &&
              isExplorationTool(
                toolIdentity(node.mcpName, node.toolName),
                node.mcpName && node.toolName ? node.mcpName : undefined,
              )
            ? "exploration"
            : node.kind === "annotation"
              ? "notice"
              : "part",
      });
    }
    return {};
  });
  return {
    projectionId,
    ids: createMemo(
      () => {
        revision();
        return [...rows.select(projectionId())];
      },
      undefined,
      {
        equals: (left, right) =>
          left.length === right.length && left.every((id, i) => id === right[i]),
      },
    ),
    row: (id: string) => {
      revision();
      return rows.row(id);
    },
    record: (id: string) => records().get(id),
    destination: (id: string) => {
      revision();
      return rows.destination(id);
    },
  };
}

export type TranscriptProjection = ReturnType<typeof createTranscriptProjection>;
