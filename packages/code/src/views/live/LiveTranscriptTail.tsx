import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  untrack,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js";
import type { ElicitRequestParams, ElicitResult } from "../../adapters/elicit-types.ts";
import type { ActivityStore } from "../../adapters/activity-store.ts";
import type { MemoryPressureSnapshot } from "../../adapters/memory-pressure.ts";
import type { NodeStatus, TranscriptNode, TranscriptStore } from "../../adapters/store.ts";
import type { TranscriptPublicationBatch } from "../../adapters/transcript-publication.ts";
import type { Interaction } from "../../keys/interaction.ts";
import type { ActivityDetail } from "../activity-detail.ts";
import { BlockView } from "../blocks.tsx";
import { ElicitBlock } from "../ElicitBlock.tsx";
import { CommittedHistoryBlockPresentationContext } from "../history/CommittedHistory.tsx";
import { MemoryPressureBanner } from "../MemoryPressureBanner.tsx";
import { computeGroupedNodes } from "../subagent-sections.ts";
import { computeToolGroups } from "../tool-groups.ts";

/** Mutable run and interaction ports rendered after immutable history. */
export interface LiveTranscriptTailProps {
  store: TranscriptStore;
  activity: ActivityStore;
  interaction: Interaction;
  active?: Accessor<boolean>;
  elicit: Accessor<ElicitRequestParams | null>;
  resolveElicit: (result: ElicitResult) => void;
  selectedSubagent: Accessor<string | null>;
  visibleCommittedKeys: Accessor<ReadonlySet<string>>;
  onHandoffKeysChange?: (keys: ReadonlySet<string>) => void;
  splitOpen: Accessor<boolean>;
  notify: (message: string) => void;
  openPlan: () => void;
  onOpenDetail?: (detail: ActivityDetail) => void;
  readingRunwayRows: Accessor<number>;
  memoryPressure?: {
    state: Accessor<MemoryPressureSnapshot>;
    onRecover: () => void;
  };
}

interface PublishedTranscriptNode {
  readonly node: TranscriptNode;
  readonly publication: TranscriptPublicationBatch;
}

interface PresentedTranscriptNode {
  readonly key: string;
  readonly node: Accessor<TranscriptNode>;
  readonly publication: Accessor<TranscriptPublicationBatch | undefined>;
  updateMutable(node: TranscriptNode): void;
  publish(value: PublishedTranscriptNode): void;
}

function createPresentedNode(
  initialNode: TranscriptNode,
  initialPublication?: TranscriptPublicationBatch,
): PresentedTranscriptNode {
  const [node, setNode] = createSignal(initialNode);
  const [publication, setPublication] = createSignal(initialPublication);
  return Object.freeze({
    key: initialNode.key,
    node,
    publication,
    updateMutable: (nextNode: TranscriptNode): void => {
      if (publication() === undefined) setNode(nextNode);
    },
    publish: (value: PublishedTranscriptNode): void => {
      batch(() => {
        setNode(value.node);
        setPublication(value.publication);
      });
    },
  });
}

function samePresentedNodes(
  left: readonly PresentedTranscriptNode[],
  right: readonly PresentedTranscriptNode[],
): boolean {
  return left.length === right.length && left.every((node, index) => node === right[index]);
}

/**
 * Renders the content-height mutable tail in the transcript's chronological flow.
 *
 * @remarks A frontier artifact that seals remains here as its frozen publication
 * snapshot until the measured committed owner is resident. The handoff prevents
 * an empty frame while keeping physical publication out of the semantic store.
 */
export function LiveTranscriptTail(props: LiveTranscriptTailProps): JSX.Element {
  const historyPresentation = useContext(CommittedHistoryBlockPresentationContext);
  const active = (): boolean => props.active?.() ?? true;
  const belongsToSelection = (node: TranscriptNode): boolean => {
    const selected = props.selectedSubagent();
    return selected === null
      ? node.subagentId === undefined && node.subagentOrder === undefined
      : node.subagentId === selected;
  };
  const frontier = createMemo(() =>
    props.store
      .frontierNodes()
      .filter(belongsToSelection)
      .filter((node) => node.kind !== "plan")
      .filter((node) => !(props.selectedSubagent() === null && node.kind === "thinking")),
  );
  const subagentStatus = createMemo(
    () =>
      new Map<string, NodeStatus>(
        props.activity.subagents.map((agent): [string, NodeStatus] => [
          agent.id,
          agent.status === "done" ? "ok" : agent.status === "error" ? "error" : "running",
        ]),
      ),
  );
  const liveGrouped = createMemo(() => computeGroupedNodes(frontier(), subagentStatus()));
  const liveToolGroups = createMemo(() => computeToolGroups(liveGrouped().ordered));
  const committedByKey = createMemo(() => {
    const nodes = new Map<string, PublishedTranscriptNode>();
    const publications = historyPresentation?.publications() ?? props.store.publicationBatches;
    for (const publication of publications)
      if (publication.phase === "committed")
        for (const node of publication.nodes)
          if (belongsToSelection(node)) nodes.set(node.key, { node, publication });
    return nodes;
  });
  const [presentedNodes, setPresentedNodes] = createSignal<readonly PresentedTranscriptNode[]>(
    Object.freeze(liveGrouped().ordered.map((node) => createPresentedNode(node))),
  );

  createEffect(() => {
    const current = liveGrouped().ordered;
    const currentByKey = new Map(current.map((node) => [node.key, node] as const));
    const visible = props.visibleCommittedKeys();
    const committed = committedByKey();
    const next: PresentedTranscriptNode[] = [];
    const retained = new Set<string>();
    for (const previous of untrack(presentedNodes)) {
      const published = committed.get(previous.key);
      if (published !== undefined) {
        previous.publish(published);
        if (!visible.has(previous.key)) {
          next.push(previous);
          retained.add(previous.key);
        }
        continue;
      }
      const currentNode = currentByKey.get(previous.key);
      if (currentNode !== undefined) {
        previous.updateMutable(currentNode);
        next.push(previous);
        retained.add(previous.key);
      }
    }
    for (const node of current) {
      if (retained.has(node.key)) continue;
      const published = committed.get(node.key);
      if (published !== undefined) {
        if (!visible.has(node.key))
          next.push(createPresentedNode(published.node, published.publication));
        continue;
      }
      next.push(createPresentedNode(node));
    }
    const frozen = Object.freeze(next);
    if (!samePresentedNodes(untrack(presentedNodes), frozen)) setPresentedNodes(frozen);
  });
  const handoffKeys = createMemo(() => {
    const visible = props.visibleCommittedKeys();
    return new Set(
      presentedNodes()
        .filter((node) => node.publication() !== undefined && !visible.has(node.key))
        .map((node) => node.key),
    );
  });
  createEffect(() => props.onHandoffKeysChange?.(handoffKeys()));

  return (
    <box
      id="live-transcript-tail"
      flexDirection="column"
      width="100%"
      minWidth={0}
      minHeight={0}
      flexShrink={0}
    >
      <For each={presentedNodes()}>
        {(presented) => {
          const publication = presented.publication;
          const published = (): boolean => publication() !== undefined;
          return (
            <box
              id={`live-transcript-owner:${presented.key}`}
              flexDirection="column"
              width="100%"
              minWidth={0}
              flexShrink={0}
            >
              <BlockView
                node={presented.node()}
                interactive={active}
                maxWidth={props.splitOpen() ? undefined : "100%"}
                forceExpand={() => published() && !!historyPresentation?.forceExpand()}
                folded={() => {
                  const value = publication();
                  if (value === undefined) return false;
                  return (
                    historyPresentation?.folded(value, presented.key) ??
                    value.sectionFoldedKeys.includes(presented.key)
                  );
                }}
                sectionFolded={() => {
                  const value = publication();
                  if (value === undefined) return false;
                  return value.sectionFoldedKeys.some(
                    (key) =>
                      value.sectionAnchors[key] === presented.key &&
                      (historyPresentation?.folded(value, key) ?? true),
                  );
                }}
                group={() =>
                  publication()?.toolGroups[presented.key] ?? liveToolGroups().get(presented.key)
                }
                sectionHeader={() => {
                  const publishedHeader = publication()?.sectionHeaders[presented.key];
                  if (publishedHeader !== undefined) return publishedHeader;
                  const liveHeader = liveGrouped().headers.get(presented.key);
                  return liveHeader?.lead ? undefined : liveHeader;
                }}
                overrideOf={(key) =>
                  published() ? historyPresentation?.overrideOf(key) : undefined
                }
                focused={() => published() && historyPresentation?.focusedKey() === presented.key}
                onToggle={
                  historyPresentation === undefined
                    ? undefined
                    : () => {
                        if (published()) historyPresentation.toggleAt(presented.key);
                      }
                }
                defaultFolded={() =>
                  publication()?.defaultFolded[presented.key] ??
                  props.store.defaultFolded(presented.key)
                }
                onOpenDetail={props.onOpenDetail}
                fillAvailableWidth={props.splitOpen}
              />
            </box>
          );
        }}
      </For>
      <Show when={props.memoryPressure !== undefined}>
        <MemoryPressureBanner
          state={() => props.memoryPressure!.state()}
          onRecover={() => {
            if (active()) props.memoryPressure!.onRecover();
          }}
        />
      </Show>
      <Show when={props.elicit()} keyed>
        {(request: ElicitRequestParams) => (
          <ElicitBlock
            interaction={props.interaction}
            request={request}
            onResolve={props.resolveElicit}
            onNotify={props.notify}
            plan={() => props.activity.plan}
            onOpenPlan={props.openPlan}
            fillAvailableWidth={props.splitOpen}
          />
        )}
      </Show>
      <box id="transcript-reading-runway" height={props.readingRunwayRows()} flexShrink={0} />
    </box>
  );
}
