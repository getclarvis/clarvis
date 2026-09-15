import type { RunEvent } from "@clarvis/protocol";
import type { EventSource, EventSpan } from "./event-span.ts";
import type { TranscriptNode } from "../core/transcript/types.ts";
import { snapshotTranscriptNode } from "../core/transcript/records.ts";
import type { TranscriptToolNode } from "../core/transcript/types.ts";

/** Completion remains an explicit host operation after durable reconciliation. */
export interface TranscriptRunCompletion {
  degraded?: string;
}

/** Ports for immutable terminal content, independent of row residence and presentation. */
export interface TranscriptContentHost {
  nodes(): readonly TranscriptNode[];
  node(key: string): TranscriptNode | undefined;
  toolArguments(node: TranscriptToolNode): Record<string, unknown> | undefined;
  seal(nodes: readonly TranscriptNode[]): void;
}

/** Stable Lead marker identity derives from delegation identity, never its title. */
export function delegationLeadMarkerKey(
  delegationId: string,
  phase: "spawned" | "settled",
): string {
  return `delegation-marker:${delegationId}:${phase}`;
}

/**
 * Seals terminal content by record identity. Ordinary events cannot revise sealed content.
 * Authoritative reconciliation stages corrections and publishes them coherently at its boundary.
 * This class owns no rows, groups, folds, rendering batches, timers or native owners.
 */
export class TranscriptContent {
  readonly #host: TranscriptContentHost;
  readonly #sealed = new Map<string, TranscriptNode>();
  readonly #reconciling = new Map<string, Map<string, TranscriptNode>>();
  constructor(host: TranscriptContentHost) {
    this.#host = host;
  }

  publishImmediate(key: string): void {
    const node = this.#host.node(key);
    if (node) this.#seal([node]);
  }

  beginReconcile(executionId: string): void {
    this.#reconciling.set(executionId, new Map());
  }

  endReconcile(executionId: string): void {
    const staged = this.#reconciling.get(executionId);
    this.#reconciling.delete(executionId);
    if (!staged) return;
    const changed: TranscriptNode[] = [];
    for (const [id, node] of staged) {
      if (JSON.stringify(this.#sealed.get(id)) === JSON.stringify(node)) continue;
      this.#sealed.set(id, node);
      changed.push(node);
    }
    if (changed.length) this.#host.seal(changed);
  }

  observe(executionId: string, span: EventSpan, event: RunEvent, source: EventSource): void {
    if (
      event.type === "tool_input_delta" ||
      event.type === "tool_output_delta" ||
      event.type === "tool_call_started" ||
      event.type === "tool_call_announced" ||
      event.type === "text_delta"
    )
      return;
    const direct =
      event.type === "tool_call"
        ? [`${executionId}::${span.span_id}`]
        : event.type === "iteration_completed"
          ? ["#msg", "#reasoning", "#error"].map(
              (suffix) => `${executionId}::${span.span_id}${suffix}`,
            )
          : undefined;
    const candidates = (
      direct
        ? direct.flatMap((key) => {
            const node = this.#host.node(key);
            return node ? [node] : [];
          })
        : this.#host.nodes()
    ).filter(
      (node) =>
        node.key.startsWith(`${executionId}::`) &&
        node.kind !== "run" &&
        node.status !== "running" &&
        node.status !== "pending",
    );
    const staged = source === "replay" ? this.#reconciling.get(executionId) : undefined;
    if (staged) {
      for (const node of candidates) {
        if (node.kind === "tool_call" && node.dehydrated) continue;
        staged.set(
          node.key,
          snapshotTranscriptNode(
            node,
            node.kind === "tool_call" ? this.#host.toolArguments(node) : undefined,
          ),
        );
      }
    } else this.#seal(candidates);
  }

  completeRun(executionId: string, completion: TranscriptRunCompletion = {}): void {
    this.endReconcile(executionId);
    this.#seal(
      this.#host
        .nodes()
        .filter(
          (node) =>
            node.key.startsWith(`${executionId}::`) &&
            node.status !== "running" &&
            node.status !== "pending",
        ),
    );
    if (completion.degraded)
      this.#seal([
        {
          key: `${executionId}::reconciliation-degraded`,
          kind: "annotation",
          status: "error",
          tone: "warn",
          text: completion.degraded,
        },
      ]);
  }

  clear(): void {
    this.#sealed.clear();
    this.#reconciling.clear();
  }
  forgetDiscarded(keys: Iterable<string>): void {
    for (const key of keys) {
      this.#sealed.delete(key);
      for (const staged of this.#reconciling.values()) staged.delete(key);
    }
  }
  knownKeyCount(): number {
    return this.#sealed.size;
  }

  #seal(candidates: readonly TranscriptNode[]): void {
    const changed: TranscriptNode[] = [];
    for (const node of candidates) {
      if (this.#sealed.has(node.key)) continue;
      const snapshot = snapshotTranscriptNode(
        node,
        node.kind === "tool_call" ? this.#host.toolArguments(node) : undefined,
      );
      this.#sealed.set(node.key, snapshot);
      changed.push(snapshot);
    }
    if (changed.length) this.#host.seal(changed);
  }
}
