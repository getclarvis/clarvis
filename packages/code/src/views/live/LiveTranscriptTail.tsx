import type { Renderable } from "@opentui/core";
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
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
  /** Published keys at or before resident history, including older virtualized batches. */
  historyOwnedKeys: Accessor<ReadonlySet<string>>;
  followingTail: Accessor<boolean>;
  isOwnerVisible: (owner: Renderable) => boolean;
  onHandoffKeysChange?: (keys: ReadonlySet<string>) => void;
  onFrontierCountChange?: (count: number) => void;
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
  readonly order: number;
  readonly node: Accessor<TranscriptNode>;
  readonly publication: Accessor<TranscriptPublicationBatch | undefined>;
  attach(owner: Renderable): void;
  measure(): void;
  measuredRows(): number;
  visible(isOwnerVisible: (owner: Renderable) => boolean): boolean;
  updateMutable(node: TranscriptNode): void;
  publish(value: PublishedTranscriptNode): void;
}

function createPresentedNode(
  initialNode: TranscriptNode,
  order: number,
  initialPublication?: TranscriptPublicationBatch,
): PresentedTranscriptNode {
  const [node, setNode] = createSignal(initialNode);
  const [publication, setPublication] = createSignal(initialPublication);
  let owner: Renderable | undefined;
  let ownerRows = 0;
  return Object.freeze({
    key: initialNode.key,
    order,
    node,
    publication,
    attach: (value: Renderable): void => {
      owner = value;
      ownerRows = Math.max(ownerRows, value.height);
    },
    measure: (): void => {
      ownerRows = Math.max(ownerRows, owner?.height ?? 0);
    },
    measuredRows: (): number => ownerRows,
    visible: (isOwnerVisible: (owner: Renderable) => boolean): boolean =>
      owner !== undefined && isOwnerVisible(owner),
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

interface ReleasedTranscriptRows {
  readonly rows: number;
  readonly order: number;
}

const RELEASED_HANDOFF_SPACER = Symbol("released-handoff-spacer");

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
 * The tail stays in ScrollBox flow after manual upward scroll. Offscreen sealed
 * owners release their render trees into one measured spacer, so native sticky
 * state keeps its geometry without accumulating one syntax subtree per tool.
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
  let nextPresentationOrder = 0;
  const present = (
    node: TranscriptNode,
    publication?: TranscriptPublicationBatch,
  ): PresentedTranscriptNode => createPresentedNode(node, nextPresentationOrder++, publication);
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
    Object.freeze(liveGrouped().ordered.map((node) => present(node))),
  );
  const [releasedRows, setReleasedRows] = createSignal<ReadonlyMap<string, ReleasedTranscriptRows>>(
    new Map(),
  );

  createEffect(() => {
    const current = liveGrouped().ordered;
    const currentByKey = new Map(current.map((node) => [node.key, node] as const));
    const historical = props.historyOwnedKeys();
    const committed = committedByKey();
    const committedPublicationIds = new Set(
      [...committed.values()].map(({ publication }) => publication.id),
    );
    const historicalPublicationIds = new Set(
      [...committed]
        .filter(([key]) => historical.has(key))
        .map(([, { publication }]) => publication.id),
    );
    const next: PresentedTranscriptNode[] = [];
    const retained = new Set<string>();
    const released = new Map<string, ReleasedTranscriptRows>();
    for (const previous of untrack(presentedNodes)) {
      const published = committed.get(previous.key);
      if (published !== undefined) {
        previous.publish(published);
        if (!historical.has(previous.key)) {
          if (props.followingTail() || previous.visible(props.isOwnerVisible)) next.push(previous);
          else {
            const rows = previous.measuredRows();
            if (rows > 0) {
              const prior = released.get(published.publication.id);
              released.set(published.publication.id, {
                rows: (prior?.rows ?? 0) + rows,
                order: Math.min(prior?.order ?? previous.order, previous.order),
              });
            }
          }
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
        if (!historical.has(node.key) && props.followingTail())
          next.push(present(published.node, published.publication));
        continue;
      }
      next.push(present(node));
    }
    const frozen = Object.freeze(next);
    if (!samePresentedNodes(untrack(presentedNodes), frozen)) setPresentedNodes(frozen);
    const previousReleased = untrack(releasedRows);
    const nextReleased = new Map<string, ReleasedTranscriptRows>();
    if (!props.followingTail()) {
      for (const [publicationId, releasedBlock] of previousReleased)
        if (
          committedPublicationIds.has(publicationId) &&
          !historicalPublicationIds.has(publicationId)
        )
          nextReleased.set(publicationId, releasedBlock);
      for (const [publicationId, releasedBlock] of released) {
        const prior = nextReleased.get(publicationId);
        nextReleased.set(publicationId, {
          rows: (prior?.rows ?? 0) + releasedBlock.rows,
          order: Math.min(prior?.order ?? releasedBlock.order, releasedBlock.order),
        });
      }
    }
    const sameReleased =
      previousReleased.size === nextReleased.size &&
      [...nextReleased].every(([key, block]) => {
        const previous = previousReleased.get(key);
        return previous?.rows === block.rows && previous.order === block.order;
      });
    if (!sameReleased) setReleasedRows(nextReleased);
  });
  const handoffKeys = createMemo(() => {
    const historical = props.historyOwnedKeys();
    return new Set(
      presentedNodes()
        .filter((node) => node.publication() !== undefined && !historical.has(node.key))
        .map((node) => node.key),
    );
  });
  createEffect(() => props.onHandoffKeysChange?.(handoffKeys()));
  createEffect(() => props.onFrontierCountChange?.(frontier().length));
  const releasedRowCount = createMemo(() =>
    [...releasedRows().values()].reduce((total, block) => total + block.rows, 0),
  );
  /**
   * Keep the aggregate spacer at the earliest released owner's chronological
   * boundary. Owners before that boundary retain both identity and flow offset
   * when a later, fully offscreen publication completes out of order.
   */
  const presentedFlow = createMemo<
    readonly (PresentedTranscriptNode | typeof RELEASED_HANDOFF_SPACER)[]
  >(() => {
    if (releasedRowCount() < 1) return presentedNodes();
    const earliestReleasedOrder = Math.min(
      ...[...releasedRows().values()].map((block) => block.order),
    );
    const nodes = presentedNodes();
    const insertion = nodes.findIndex((node) => node.order > earliestReleasedOrder);
    const index = insertion < 0 ? nodes.length : insertion;
    return Object.freeze([
      ...nodes.slice(0, index),
      RELEASED_HANDOFF_SPACER,
      ...nodes.slice(index),
    ]);
  });
  onCleanup(() => {
    props.onHandoffKeysChange?.(new Set());
    props.onFrontierCountChange?.(0);
  });

  return (
    <box
      id="live-transcript-tail"
      flexDirection="column"
      width="100%"
      minWidth={0}
      minHeight={0}
      flexShrink={0}
    >
      <For each={presentedFlow()}>
        {(item) => {
          if (item === RELEASED_HANDOFF_SPACER)
            return (
              <box id="live-transcript-handoff-spacer" height={releasedRowCount()} flexShrink={0} />
            );
          const presented = item;
          const publication = presented.publication;
          const published = (): boolean => publication() !== undefined;
          return (
            <box
              id={`live-transcript-owner:${presented.key}`}
              ref={(owner: Renderable) => presented.attach(owner)}
              onSizeChange={() => presented.measure()}
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
