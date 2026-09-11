import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
  type JSX,
} from "solid-js";
import type { ElicitRequestParams, ElicitResult } from "../../adapters/elicit-types.ts";
import type { ActivityStore } from "../../adapters/activity-store.ts";
import type { MemoryPressureSnapshot } from "../../adapters/memory-pressure.ts";
import type { NodeStatus, TranscriptNode, TranscriptStore } from "../../adapters/store.ts";
import type { Interaction } from "../../keys/interaction.ts";
import type { ActivityDetail } from "../activity-detail.ts";
import { BlockView } from "../blocks.tsx";
import { ElicitBlock } from "../ElicitBlock.tsx";
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
  /** Published keys that already have a committed-history owner. */
  historyOwnedKeys: Accessor<ReadonlySet<string>>;
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

interface PresentedTranscriptNode {
  readonly key: string;
  readonly node: Accessor<TranscriptNode>;
  update(node: TranscriptNode): void;
}

function createPresentedNode(initialNode: TranscriptNode): PresentedTranscriptNode {
  const [node, setNode] = createSignal(initialNode);
  return Object.freeze({
    key: initialNode.key,
    node,
    update: (nextNode: TranscriptNode): void => {
      setNode(nextNode);
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
 * @remarks The tail stays mounted after manual upward scroll. Native sticky
 * state owns follow-the-end behavior; this owner never unmounts while the run
 * is open.
 */
export function LiveTranscriptTail(props: LiveTranscriptTailProps): JSX.Element {
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
    const nodes = new Map<string, TranscriptNode>();
    for (const publication of props.store.publicationBatches)
      if (publication.phase === "committed")
        for (const node of publication.nodes)
          if (belongsToSelection(node)) nodes.set(node.key, node);
    return nodes;
  });
  const [presentedNodes, setPresentedNodes] = createSignal<readonly PresentedTranscriptNode[]>(
    Object.freeze(liveGrouped().ordered.map((node) => createPresentedNode(node))),
  );

  createEffect(() => {
    const current = liveGrouped().ordered;
    const currentByKey = new Map(current.map((node) => [node.key, node] as const));
    const historical = props.historyOwnedKeys();
    const committed = committedByKey();
    const next: PresentedTranscriptNode[] = [];
    const retained = new Set<string>();
    for (const previous of untrack(presentedNodes)) {
      if (historical.has(previous.key)) continue;
      const currentNode = currentByKey.get(previous.key);
      const published = committed.get(previous.key);
      if (currentNode === undefined && published === undefined) continue;
      if (!belongsToSelection(currentNode ?? published!)) continue;
      if (currentNode !== undefined && published === undefined) previous.update(currentNode);
      else if (published !== undefined) previous.update(published);
      next.push(previous);
      retained.add(previous.key);
    }
    for (const node of current) {
      if (retained.has(node.key) || historical.has(node.key)) continue;
      next.push(createPresentedNode(committed.get(node.key) ?? node));
    }
    const frozen = Object.freeze(next);
    if (!samePresentedNodes(untrack(presentedNodes), frozen)) setPresentedNodes(frozen);
  });
  createEffect(() => props.onFrontierCountChange?.(frontier().length));
  onCleanup(() => {
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
      <For each={presentedNodes()}>
        {(presented) => (
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
              forceExpand={() => false}
              folded={() => false}
              sectionFolded={() => false}
              group={() => liveToolGroups().get(presented.key)}
              sectionHeader={() => {
                const liveHeader = liveGrouped().headers.get(presented.key);
                return liveHeader?.lead ? undefined : liveHeader;
              }}
              overrideOf={() => undefined}
              focused={() => false}
              defaultFolded={() => props.store.defaultFolded(presented.key)}
              onOpenDetail={props.onOpenDetail}
              fillAvailableWidth={props.splitOpen}
            />
          </box>
        )}
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
