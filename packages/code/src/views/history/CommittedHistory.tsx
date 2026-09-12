import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
  type JSX,
} from "solid-js";
import type {
  TranscriptPublicationBatch,
  TranscriptPublicationSectionHeader,
  TranscriptPublicationToolGroup,
} from "../../adapters/transcript-publication.ts";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import { scrollbarOptions, SCROLLBOX_TABLE_GUTTER } from "../../theme/surfaces.ts";
import type { ActivityDetail } from "../activity-detail.ts";
import type { BlockOverride } from "../block-focus.ts";
import { BlockView } from "../blocks.tsx";
import { selectTailOwnedKeys } from "./tail-ownership.ts";
import { createVisibleSliceController, type TranscriptVisibleSlice } from "./visible-slice.ts";

/** One permanently reserved column keeps scrollbar visibility out of content width. */
const TRANSCRIPT_SCROLLBAR_COLUMNS = 1;

/** User-driven view state accepted by committed history. */
export interface CommittedHistoryState {
  semanticNodes: Accessor<TranscriptPublicationBatch["nodes"]>;
  expandAll: Accessor<boolean>;
  selectedSubagent: Accessor<string | null>;
  focusedKey: Accessor<string | null>;
  overrideOf(key: string): BlockOverride | undefined;
  toggleAt(key: string): void;
}

/** The only reactive store seam allowed to cross into committed-history ownership. */
export interface CommittedHistoryPublicationStore {
  readonly publicationBatches: readonly TranscriptPublicationBatch[];
}

/** Native navigation exposed to application key handling. */
export type CommittedHistoryScrollResult = "scrolled" | "preparing" | "start" | "end";

/** Native navigation exposed to application key handling. */
export interface CommittedHistoryHandle {
  requestEarlier(): boolean;
  requestLater(): boolean;
  returnToTail(): boolean;
  scrollBy(rows: number): CommittedHistoryScrollResult;
  revealKey(key: string): boolean;
  snapshot(): TranscriptVisibleSlice;
  diagnostics(): {
    readonly pendingRevealKey: string | null;
    readonly laterEntries: number;
    readonly tailEntries: number;
    readonly newerEntries: number;
    readonly stickyScroll: boolean;
  };
}

/** Inputs owned by the immutable, index-windowed history surface. */
export interface CommittedHistoryProps {
  store: CommittedHistoryPublicationStore;
  transcript: CommittedHistoryState;
  active?: Accessor<boolean>;
  splitOpen: Accessor<boolean>;
  notify: (message: string) => void;
  onOpenDetail?: (detail: ActivityDetail) => void;
  onScrollbox: (scrollbox: ScrollBoxRenderable) => void;
  onHandle?: (handle: CommittedHistoryHandle | undefined) => void;
  /** Mutable frontier artifacts included in the off-tail newer-entry overlay. */
  tailEntries?: Accessor<number>;
  /** Live frontier keys for the active Lead/child projection, in arrival order. */
  frontierKeys?: Accessor<readonly string[]>;
  /**
   * Chronological final flow owner. The live tail stays mounted whether or not
   * native sticky following is currently paused. `tailOwnedKeys` is the suffix
   * this tail currently paints, including committed snapshots it still owns.
   */
  tail?: (tailOwnedKeys: Accessor<readonly string[]>) => JSX.Element;
}

function sectionFolded(
  batch: TranscriptPublicationBatch,
  key: string,
  transcript: CommittedHistoryState,
): boolean {
  if (!batch.sectionFoldedKeys.includes(key)) return false;
  const anchor = batch.sectionAnchors[key];
  if (anchor === undefined) return false;
  const override = transcript.overrideOf(anchor);
  if (override === "expanded") return false;
  if (override === "collapsed") return true;
  return true;
}

type PublicationToolNode = Extract<
  TranscriptPublicationBatch["nodes"][number],
  { kind: "tool_call" }
>;

const projectedPublicationCache = new WeakMap<
  TranscriptPublicationBatch,
  Map<string, TranscriptPublicationBatch>
>();

/** Lead plus the one retained child are the only cached projections of a publication. */
const TRANSCRIPT_PROJECTION_CACHE_LIMIT = 2;

function projectPublicationBatch(
  publication: TranscriptPublicationBatch,
  semanticKeys: ReadonlySet<string>,
): TranscriptPublicationBatch | undefined {
  const nodes = publication.nodes.filter((node) => semanticKeys.has(node.key));
  if (nodes.length === 0) return undefined;
  if (nodes.length === publication.nodes.length) return publication;

  const projectionKey = JSON.stringify(nodes.map((node) => node.key));
  const cached = projectedPublicationCache.get(publication);
  const cachedProjection = cached?.get(projectionKey);
  if (cachedProjection !== undefined) {
    cached!.delete(projectionKey);
    cached!.set(projectionKey, cachedProjection);
    return cachedProjection;
  }

  const includedKeys = new Set(nodes.map((node) => node.key));
  const defaultFolded: Record<string, boolean> = Object.create(null);
  const sectionHeaders: Record<string, TranscriptPublicationSectionHeader> = Object.create(null);
  const sectionAnchors: Record<string, string> = Object.create(null);
  const groupedTools = new Map<string, PublicationToolNode[]>();
  for (const node of nodes) {
    defaultFolded[node.key] = publication.defaultFolded[node.key] ?? false;
    const header = publication.sectionHeaders[node.key];
    if (header !== undefined) sectionHeaders[node.key] = header;
    const anchor = publication.sectionAnchors[node.key];
    if (anchor !== undefined && includedKeys.has(anchor)) sectionAnchors[node.key] = anchor;
    if (node.kind !== "tool_call") continue;
    const group = publication.toolGroups[node.key];
    if (group === undefined) continue;
    const groupKey = group.headKey ?? node.key;
    const members = groupedTools.get(groupKey);
    if (members === undefined) groupedTools.set(groupKey, [node]);
    else members.push(node);
  }

  const toolGroups: Record<string, TranscriptPublicationToolGroup> = Object.create(null);
  for (const members of groupedTools.values()) {
    if (members.length === 1) {
      toolGroups[members[0]!.key] = Object.freeze({ role: "solo", ordinal: 0, size: 1 });
      continue;
    }
    const frozenMembers = Object.freeze([...members]);
    const headKey = frozenMembers[0]!.key;
    for (const [ordinal, member] of frozenMembers.entries())
      toolGroups[member.key] = Object.freeze(
        ordinal === 0
          ? { role: "head", ordinal, size: frozenMembers.length, members: frozenMembers, headKey }
          : { role: "member", ordinal, size: frozenMembers.length, headKey },
      );
  }

  const projected = Object.freeze({
    ...publication,
    nodes: Object.freeze(nodes),
    defaultFolded: Object.freeze(defaultFolded),
    toolGroups: Object.freeze(toolGroups),
    sectionHeaders: Object.freeze(sectionHeaders),
    sectionAnchors: Object.freeze(sectionAnchors),
    sectionFoldedKeys: Object.freeze(
      publication.sectionFoldedKeys.filter(
        (key) => includedKeys.has(key) && sectionAnchors[key] !== undefined,
      ),
    ),
  });
  const projections = cached ?? new Map<string, TranscriptPublicationBatch>();
  projections.set(projectionKey, projected);
  while (projections.size > TRANSCRIPT_PROJECTION_CACHE_LIMIT) {
    const oldest = projections.keys().next().value;
    if (oldest === undefined) break;
    projections.delete(oldest);
  }
  if (cached === undefined) projectedPublicationCache.set(publication, projections);
  return projected;
}

function PublicationOwner(props: {
  batch: TranscriptPublicationBatch;
  transcript: CommittedHistoryState;
  splitOpen: Accessor<boolean>;
  interactive: Accessor<boolean>;
  omitKeys: Accessor<ReadonlySet<string>>;
  onOpenDetail?: (detail: ActivityDetail) => void;
}): JSX.Element {
  const nodes = createMemo(() => {
    const omit = props.omitKeys();
    if (omit.size === 0) return props.batch.nodes;
    return props.batch.nodes.filter((node) => !omit.has(node.key));
  });
  const group = (key: string): TranscriptPublicationToolGroup | undefined =>
    props.batch.toolGroups[key];
  const header = (key: string): TranscriptPublicationSectionHeader | undefined =>
    props.batch.sectionHeaders[key];
  return (
    <box
      id={`history:${props.batch.id}`}
      flexDirection="column"
      width="100%"
      minWidth={0}
      flexShrink={0}
    >
      <For each={nodes()}>
        {(node) => (
          <BlockView
            node={node}
            interactive={props.interactive}
            maxWidth={props.splitOpen() ? undefined : "100%"}
            forceExpand={props.transcript.expandAll}
            folded={() => sectionFolded(props.batch, node.key, props.transcript)}
            sectionFolded={() =>
              props.batch.sectionFoldedKeys.some(
                (key) =>
                  props.batch.sectionAnchors[key] === node.key &&
                  sectionFolded(props.batch, key, props.transcript),
              )
            }
            group={() => group(node.key)}
            sectionHeader={() => header(node.key)}
            overrideOf={(key) => props.transcript.overrideOf(key)}
            focused={() => props.transcript.focusedKey() === node.key}
            onToggle={() => props.transcript.toggleAt(node.key)}
            defaultFolded={() => props.batch.defaultFolded[node.key] ?? false}
            onOpenDetail={props.onOpenDetail}
            fillAvailableWidth={props.splitOpen}
          />
        )}
      </For>
    </box>
  );
}

function atScrollBottom(element: ScrollBoxRenderable): boolean {
  return element.scrollTop >= Math.max(0, element.scrollHeight - element.viewport.height - 1);
}

/**
 * Renders frozen publication batches through a native OpenTUI ScrollBox.
 *
 * @remarks Every resident batch is a direct ScrollBox content child. Off-window
 * owners are unmounted by index, not by measured Yoga rows. Native sticky
 * scrolling is the only authority for following the live tail; viewport culling
 * stays enabled.
 */
export function CommittedHistory(props: CommittedHistoryProps): JSX.Element {
  const renderer = useRenderer();
  const controller = createVisibleSliceController();
  const active = (): boolean => props.active?.() ?? true;
  const [scrollbox, setScrollbox] = createSignal<ScrollBoxRenderable>();
  const [slice, setSlice] = createSignal(controller.snapshot());
  let frameQueued = false;
  let pendingRevealKey: string | null = null;
  let lastNativeScrollTop = 0;

  const semanticKeys = createMemo(
    () => new Set(props.transcript.semanticNodes().map((node) => node.key)),
  );
  const semanticBatches = createMemo(() => {
    const keys = semanticKeys();
    const publications: TranscriptPublicationBatch[] = [];
    for (const publication of props.store.publicationBatches) {
      if (publication.phase !== "committed") continue;
      const projected = projectPublicationBatch(publication, keys);
      if (projected !== undefined) publications.push(projected);
    }
    return publications;
  });
  const mountedBatches = createMemo(() => {
    const ids = new Set(slice().activeBatchIds);
    return semanticBatches().filter((batch) => ids.has(batch.id));
  });
  const mountedKeysInOrder = createMemo(() =>
    mountedBatches().flatMap((batch) => batch.nodes.map((node) => node.key)),
  );
  const committedKeysInOrder = createMemo(() =>
    semanticBatches().flatMap((batch) => batch.nodes.map((node) => node.key)),
  );
  let previousTailOwned: ReadonlySet<string> = new Set();
  const tailOwnedKeys = createMemo(() => {
    const frontier = props.frontierKeys?.() ?? [];
    if (!active()) {
      previousTailOwned = new Set(frontier);
      return frontier;
    }
    const mounted = mountedKeysInOrder();
    const following = slice().followingTail;
    const next = selectTailOwnedKeys(
      previousTailOwned,
      mounted,
      frontier,
      committedKeysInOrder(),
      following,
    );
    if (following && mounted.length === 0 && next.length === 0 && previousTailOwned.size > 0) {
      return [...previousTailOwned];
    }
    previousTailOwned = new Set(next);
    return next;
  });
  const tailOwnedSet = createMemo(() => new Set(tailOwnedKeys()));
  const laterEntries = createMemo(() => slice().laterUnknown);
  const newerEntries = createMemo(() => Math.max(0, laterEntries() + (props.tailEntries?.() ?? 0)));

  const publish = (): void => {
    setSlice(controller.snapshot());
  };
  const synchronize = (): boolean => {
    if (!active()) return false;
    const element = scrollbox();
    return controller.sync({
      batchIds: semanticBatches().map((batch) => batch.id),
      columns: Math.max(1, element?.content.width ?? 1),
      viewportRows: element?.viewport.height ?? 1,
      scrollTop: element?.scrollTop ?? 0,
    });
  };
  const synchronizeScrollbar = (element: ScrollBoxRenderable): void => {
    const opacity = element.scrollHeight > element.viewport.height ? 1 : 0;
    if (element.verticalScrollBar.opacity !== opacity) element.verticalScrollBar.opacity = opacity;
  };
  const requestRender = (): void => {
    publish();
    renderer.requestRender();
  };
  const scrollToBottom = (element: ScrollBoxRenderable): void => {
    element.scrollTo({
      x: 0,
      y: Math.max(0, element.scrollHeight - element.viewport.height),
    });
  };
  const returnToTail = (): boolean => {
    pendingRevealKey = null;
    const changed = controller.returnToTail();
    const element = scrollbox();
    if (element !== undefined) {
      scrollToBottom(element);
      lastNativeScrollTop = element.scrollTop;
    }
    requestRender();
    return changed;
  };
  const revealPending = (): void => {
    const key = pendingRevealKey;
    const element = scrollbox();
    if (key === null || element === undefined) return;
    const batch = semanticBatches().find((candidate) =>
      candidate.nodes.some((node) => node.key === key),
    );
    if (batch === undefined || !controller.snapshot().activeBatchIds.includes(batch.id)) return;
    const targetId =
      element.content.findDescendantById(key) === undefined ? `history:${batch.id}` : key;
    element.scrollChildIntoView(targetId);
    pendingRevealKey = null;
  };
  const observeFrame = (): void => {
    const element = scrollbox();
    if (element === undefined || renderer.isDestroyed || !active()) return;
    synchronizeScrollbar(element);
    let changed = synchronize();
    revealPending();
    const maxScrollTop = Math.max(0, element.scrollHeight - element.viewport.height);
    const canScroll = maxScrollTop > 1;
    const atBottom = atScrollBottom(element);
    const atTop = element.scrollTop <= 1;
    const previousNativeTop = lastNativeScrollTop;
    const following = controller.snapshot().followingTail;
    if (
      following &&
      !atBottom &&
      canScroll &&
      (element.scrollTop < previousNativeTop || !element.stickyScroll)
    )
      changed = controller.pauseFollowing() || changed;
    const followingNow = controller.snapshot().followingTail;
    const arrivedAtTop = atTop && previousNativeTop > 1;
    const arrivedAtBottom = atBottom && previousNativeTop < Math.max(0, maxScrollTop - 1);
    if (!followingNow && canScroll && arrivedAtTop && controller.snapshot().earlierUnknown > 0)
      changed = controller.revealOlder() || changed;
    else if (canScroll && arrivedAtBottom && controller.snapshot().laterUnknown > 0)
      changed = controller.revealNewer() || changed;
    else
      changed =
        controller.observe({
          scrollTop: element.scrollTop,
          viewportRows: element.viewport.height,
          atBottom: atBottom && (followingNow || canScroll),
        }) || changed;
    lastNativeScrollTop = element.scrollTop;
    if (changed) {
      publish();
      renderer.requestRender();
    }
  };
  const queueFrameObservation = (): void => {
    if (frameQueued) return;
    frameQueued = true;
    queueMicrotask(() => {
      frameQueued = false;
      observeFrame();
    });
  };

  const scrollBy = (requestedRows: number): CommittedHistoryScrollResult => {
    const element = scrollbox();
    const rows = Math.trunc(requestedRows);
    if (element === undefined || rows === 0) return "scrolled";
    if (rows < 0) controller.pauseFollowing();
    const maxScrollTop = Math.max(0, element.scrollHeight - element.viewport.height);
    const target = element.scrollTop + rows;
    if (rows < 0 && target <= 0) {
      if (element.scrollTop !== 0) element.scrollTo({ x: 0, y: 0 });
      lastNativeScrollTop = element.scrollTop;
      const accepted = controller.revealOlder();
      if (accepted) requestRender();
      return accepted ? "preparing" : "start";
    }
    if (rows > 0 && target >= maxScrollTop) {
      if (controller.snapshot().laterUnknown > 0) {
        const accepted = controller.revealNewer();
        if (accepted) requestRender();
        return accepted ? "preparing" : "end";
      }
      returnToTail();
      return "end";
    }
    element.scrollTo({ x: 0, y: Math.max(0, Math.min(maxScrollTop, target)) });
    renderer.requestRender();
    return "scrolled";
  };

  const handle: CommittedHistoryHandle = {
    requestEarlier: () => {
      pendingRevealKey = null;
      controller.pauseFollowing();
      const accepted = controller.revealOlder();
      lastNativeScrollTop = scrollbox()?.scrollTop ?? lastNativeScrollTop;
      if (accepted) requestRender();
      return accepted;
    },
    scrollBy,
    returnToTail,
    requestLater: () => {
      const accepted = controller.revealNewer();
      if (accepted) requestRender();
      else returnToTail();
      return accepted;
    },
    revealKey: (key) => {
      const batch = semanticBatches().find((candidate) =>
        candidate.nodes.some((node) => node.key === key),
      );
      if (batch === undefined) return false;
      pendingRevealKey = key;
      const accepted = controller.ensureBatch(batch.id);
      if (accepted) requestRender();
      revealPending();
      return true;
    },
    snapshot: () => controller.snapshot(),
    diagnostics: () => ({
      pendingRevealKey,
      laterEntries: laterEntries(),
      tailEntries: props.tailEntries?.() ?? 0,
      newerEntries: newerEntries(),
      stickyScroll: controller.snapshot().followingTail && !controller.snapshot().navigating,
    }),
  };

  createEffect(() => {
    if (!active()) return;
    semanticBatches();
    props.transcript.expandAll();
    if (synchronize()) requestRender();
  });

  renderer.on("frame", queueFrameObservation);
  props.onHandle?.(handle);
  onCleanup(() => {
    renderer.off("frame", queueFrameObservation);
    props.onHandle?.(undefined);
  });

  const setScrollboxRef = (value: ScrollBoxRenderable): void => {
    value.verticalScrollBar.visible = true;
    synchronizeScrollbar(value);
    setScrollbox(value);
    props.onScrollbox(value);
    if (synchronize()) requestRender();
  };
  return (
    <scrollbox
      id="committed-history"
      ref={setScrollboxRef}
      stickyScroll={slice().followingTail && !slice().navigating}
      stickyStart="bottom"
      viewportCulling
      flexGrow={1}
      minHeight={0}
      paddingLeft={1}
      paddingRight={SCROLLBOX_TABLE_GUTTER}
      contentOptions={{ alignItems: "flex-start" }}
      verticalScrollbarOptions={{
        ...scrollbarOptions(),
        width: TRANSCRIPT_SCROLLBAR_COLUMNS,
      }}
      onMouse={(event: MouseEvent) => {
        if (event.type !== "scroll" || event.modifiers.shift) return;
        const direction = event.scroll?.direction;
        const element = scrollbox();
        if (element === undefined || (direction !== "up" && direction !== "down")) return;
        if (direction === "up") {
          controller.pauseFollowing();
          if (element.scrollTop <= 1) {
            controller.revealOlder();
            lastNativeScrollTop = element.scrollTop;
          }
        } else if (atScrollBottom(element)) {
          if (controller.snapshot().laterUnknown > 0) controller.revealNewer();
          else controller.returnToTail();
        }
        publish();
        renderer.requestRender();
      }}
    >
      <Show when={slice().earlierUnknown > 0}>
        <box id="history-boundary-earlier" height={1} flexShrink={0} paddingLeft={1}>
          <text fg={tokens.muted} wrapMode="none" truncate selectable={false}>
            {`${glyph("caretUp")} ${slice().earlierUnknown} earlier entr${slice().earlierUnknown === 1 ? "y" : "ies"} ${glyph("emDash")} scroll to load`}
          </text>
        </box>
      </Show>
      <For each={mountedBatches()}>
        {(batch) => (
          <PublicationOwner
            batch={batch}
            transcript={props.transcript}
            splitOpen={props.splitOpen}
            interactive={active}
            omitKeys={tailOwnedSet}
            onOpenDetail={props.onOpenDetail}
          />
        )}
      </For>
      <Show when={slice().laterUnknown > 0}>
        <box id="history-boundary-later" height={1} flexShrink={0} paddingLeft={1}>
          <text fg={tokens.muted} wrapMode="none" truncate selectable={false}>
            {`${glyph("caretDown")} ${slice().laterUnknown} newer frozen entr${slice().laterUnknown === 1 ? "y" : "ies"}`}
          </text>
        </box>
      </Show>
      {props.tail?.(tailOwnedKeys)}
      <Show when={!slice().followingTail}>
        <box
          id="history-newer-indicator"
          position="absolute"
          left={1}
          top={slice().scrollTop}
          height={1}
          zIndex={3}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={tokens.bgElev}
        >
          <text fg={tokens.accent2} wrapMode="none" truncate selectable={false}>
            {newerEntries() > 0
              ? `${glyph("caretDown")} ${newerEntries()} newer entr${newerEntries() === 1 ? "y" : "ies"}`
              : `${glyph("caretDown")} follow the tail`}
          </text>
        </box>
      </Show>
    </scrollbox>
  );
}
