import { batch, createRoot } from "solid-js";
import type { RunDetail } from "@clarvis/protocol";
import {
  applyEvent,
  boundTranscriptText,
  createTranscriptStore,
  transcriptTextFingerprint,
  type TranscriptNode,
  type TranscriptStore,
  type TranscriptStoreDeps,
} from "./store.ts";
import { contentToText } from "./message-content.ts";
import type { SessionMeta } from "./session-store.ts";

/** A bounded resident view and an incremental reference to canonical turn metadata. */
export interface TranscriptExportSnapshot {
  readonly sessionId: string | null;
  readonly turns: Readonly<SessionMeta["turns"]> | undefined;
  readonly foldedTurnCount: number;
  /** Current fold state only while this snapshot still owns the active session. */
  readonly foldState: () => { foldedTurnCount: number; foldedPrefix: number } | null;
  readonly residentNodes: readonly TranscriptNode[];
  readonly isolatedChildren: boolean;
}

/** Only the read ports required to rebuild one transcript export. */
export interface TranscriptExportSource {
  snapshot(): TranscriptExportSnapshot;
  getRun(executionId: string, sessionId: string | null): Promise<RunDetail | null>;
  describeToolCall?: TranscriptStoreDeps["describeToolCall"];
  /** Test seam for observing scratch-root disposal with the production store. */
  createScratch?: () => TranscriptStore;
}

/** Export batch size bounds one yielded allocation without changing node order. */
const EXPORT_BATCH_NODE_LIMIT = 128;
const EXPORT_INCOMPLETE_PREFIX =
  "EXPORT INCOMPLETE — original transcript prose was released from the live TUI";

type ProseNode = TranscriptNode & { kind: "user" | "assistant" | "reasoning" };

function isReleasedProse(node: TranscriptNode): node is ProseNode {
  return (
    (node.kind === "user" || node.kind === "assistant" || node.kind === "reasoning") &&
    node.proseReleased === true
  );
}

function sourceExecutionId(node: ProseNode): string | undefined {
  if (node.kind === "user") return node.sourceExecutionId;
  const separator = node.key.indexOf("::");
  return separator > 0 ? node.key.slice(0, separator) : undefined;
}

function incompleteExportNode(node: ProseNode, reason: string): TranscriptNode {
  return {
    ...node,
    proseReleased: undefined,
    textTruncated: true,
    text: `${EXPORT_INCOMPLETE_PREFIX}; ${reason}.`,
  };
}

/**
 * Rebuild folded and released transcript content one run at a time.
 *
 * @remarks The scratch store has no live aggregate caps because one persisted
 * run occupies it at a time; the trace store bounds each record. The Solid
 * root is disposed on completion, failure, and early iterator return.
 */
export async function* exportTranscriptBatches(
  deps: TranscriptExportSource,
): AsyncGenerator<readonly TranscriptNode[]> {
  const snapshot = deps.snapshot();
  let scratch!: TranscriptStore;
  const dispose = createRoot((d) => {
    scratch =
      deps.createScratch?.() ??
      createTranscriptStore({
        ...(deps.describeToolCall ? { describeToolCall: deps.describeToolCall } : {}),
        proseTotalLimitBytes: Number.MAX_SAFE_INTEGER,
        hydratedToolLimit: Number.MAX_SAFE_INTEGER,
        hydratedToolBytesLimit: Number.MAX_SAFE_INTEGER,
        hydratedToolSingleBytesLimit: Number.MAX_SAFE_INTEGER,
      });
    return d;
  });

  async function* exportResidentNodes(
    nodes: readonly TranscriptNode[],
  ): AsyncGenerator<readonly TranscriptNode[]> {
    let outputBatch: TranscriptNode[] = [];
    let cachedExecutionId: string | undefined;
    let cachedDetail: RunDetail | null = null;
    let restored = new Map<string, TranscriptNode>();
    let fetchFailed = false;

    const loadPersisted = async (executionId: string): Promise<void> => {
      if (executionId === cachedExecutionId) return;
      cachedExecutionId = executionId;
      cachedDetail = null;
      restored = new Map();
      fetchFailed = false;
      try {
        cachedDetail = await deps.getRun(executionId, snapshot.sessionId);
      } catch {
        fetchFailed = true;
        return;
      }
      if (cachedDetail === null) return;
      scratch.clear();
      const sink = scratch.openRun(executionId);
      batch(() => {
        sink.beginReconcile();
        for (const event of cachedDetail!.events) applyEvent(sink, event, "replay");
        sink.endReconcile();
        sink.complete();
      });
      restored = new Map(scratch.nodes.map((candidate) => [candidate.key, candidate]));
    };

    for (const node of nodes) {
      let exported = node;
      if (isReleasedProse(node)) {
        const executionId = sourceExecutionId(node);
        if (executionId === undefined) {
          exported = incompleteExportNode(node, "no persisted run identifies this block");
        } else {
          await loadPersisted(executionId);
          const persisted = cachedDetail as RunDetail | null;
          if (fetchFailed) {
            exported = incompleteExportNode(node, `run ${executionId} could not be fetched`);
          } else if (persisted === null) {
            exported = incompleteExportNode(node, `run ${executionId} is no longer retained`);
          } else if (node.kind === "user") {
            const content = persisted.messages.at(-1)?.content;
            if (content === undefined) {
              exported = incompleteExportNode(node, `run ${executionId} has no recoverable prompt`);
            } else {
              const text = contentToText(content);
              if (
                node.sourceTextFingerprint !== undefined &&
                node.sourceTextFingerprint !== transcriptTextFingerprint(text)
              ) {
                exported = incompleteExportNode(
                  node,
                  `run ${executionId}'s persisted prompt does not match this displayed block`,
                );
              } else {
                const bounded = boundTranscriptText(text);
                exported = {
                  ...node,
                  text: bounded.text,
                  textTruncated: bounded.truncated ? true : undefined,
                  proseReleased: undefined,
                };
              }
            }
          } else {
            const candidate = restored.get(node.key);
            if (
              candidate === undefined ||
              (candidate.kind !== "assistant" && candidate.kind !== "reasoning") ||
              candidate.proseReleased === true
            ) {
              exported = incompleteExportNode(
                node,
                `run ${executionId} has no recoverable ${node.kind} block`,
              );
            } else {
              exported = { ...candidate };
            }
          }
        }
      }
      outputBatch.push(exported);
      if (outputBatch.length >= EXPORT_BATCH_NODE_LIMIT) {
        yield outputBatch;
        outputBatch = [];
      }
    }
    if (outputBatch.length > 0) yield outputBatch;
  }

  async function* exportResidentWithChildren(
    nodes: readonly TranscriptNode[],
  ): AsyncGenerator<readonly TranscriptNode[]> {
    const segments: TranscriptNode[][] = [];
    let segment: TranscriptNode[] = [];
    for (const node of nodes) {
      if (node.kind === "user" && segment.length > 0) {
        segments.push(segment);
        segment = [];
      }
      segment.push(node);
    }
    if (segment.length > 0) segments.push(segment);

    for (const current of segments) {
      const user = current.find((node) => node.kind === "user");
      const executionId = user?.kind === "user" ? user.sourceExecutionId : undefined;
      if (executionId === undefined) {
        yield* exportResidentNodes(current);
        continue;
      }
      let detail: RunDetail | null = null;
      try {
        detail = await deps.getRun(executionId, snapshot.sessionId);
      } catch {
        detail = null;
      }
      if (detail === null) {
        if (current.some((node) => node.kind === "subagent")) {
          yield* exportResidentNodes([
            ...current,
            {
              key: `export:missing-children:${executionId}`,
              kind: "assistant",
              status: "error",
              text: `EXPORT INCOMPLETE — run ${executionId} child transcripts could not be reloaded.`,
            },
          ]);
        } else yield* exportResidentNodes(current);
        continue;
      }
      scratch.clear();
      const sink = scratch.openRun(executionId);
      batch(() => {
        sink.beginReconcile();
        for (const event of detail.events) applyEvent(sink, event, "replay");
        sink.endReconcile();
        sink.complete();
      });
      const replayed = [...scratch.nodes];
      const replayedKeys = new Set(replayed.map((node) => node.key));
      const insertion = current.findIndex((node) => node.key.startsWith(`${executionId}::`));
      const at = insertion < 0 ? 1 : insertion;
      const before = current.slice(0, at).filter((node) => !replayedKeys.has(node.key));
      const after = current.slice(at).filter((node) => !replayedKeys.has(node.key));
      yield* exportResidentNodes([...before, ...replayed, ...after]);
    }
  }

  try {
    const residentNodes = snapshot.residentNodes;
    if (snapshot.foldedTurnCount === 0) {
      if (snapshot.isolatedChildren) {
        yield* exportResidentWithChildren(residentNodes);
        return;
      }
      if (!residentNodes.some(isReleasedProse)) {
        yield residentNodes;
        return;
      }
      yield* exportResidentNodes(residentNodes);
      return;
    }

    const canonicalTurns = snapshot.turns;
    for (let index = 0; index < (snapshot.foldState()?.foldedTurnCount ?? 0); index += 1) {
      scratch.clear();
      const turn = canonicalTurns?.[index];
      if (turn === undefined) {
        scratch.appendUserMessage(`Earlier turn ${index + 1}`);
        scratch.appendNotice("folded — this turn's session metadata could not be reloaded", "info");
        yield [...scratch.nodes];
        continue;
      }
      const executionId = turn.executionId;
      if (executionId === undefined) {
        scratch.appendUserMessage(turn.userPreview);
        scratch.appendNotice("folded — this turn has no persisted run to reload", "info");
        yield [...scratch.nodes];
        continue;
      }
      let detail: RunDetail | null = null;
      try {
        detail = await deps.getRun(executionId, snapshot.sessionId);
      } catch {
        detail = null;
      }
      if (!detail) {
        scratch.appendUserMessage(turn.userPreview, undefined, executionId);
        scratch.appendNotice("folded — this turn's reply could not be reloaded", "info");
      } else {
        const persistedUserContent =
          turn.kind === "conversation" ? detail.messages.at(-1)?.content : undefined;
        scratch.appendUserMessage(persistedUserContent ?? turn.userPreview, undefined, executionId);
        if (turn.kind === "conversation" && persistedUserContent === undefined)
          scratch.appendNotice(
            "folded — this turn's complete prompt could not be reloaded",
            "info",
          );
        const sink = scratch.openRun(executionId);
        batch(() => {
          sink.beginReconcile();
          for (const event of detail.events) applyEvent(sink, event, "replay");
          sink.endReconcile();
          sink.complete();
        });
      }
      yield [...scratch.nodes];
    }
    const foldedPrefix = snapshot.foldState()?.foldedPrefix ?? 0;
    if (snapshot.isolatedChildren)
      yield* exportResidentWithChildren(residentNodes.slice(foldedPrefix));
    else yield* exportResidentNodes(residentNodes.slice(foldedPrefix));
  } finally {
    dispose();
  }
}
