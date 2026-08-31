import type { Renderable, ScrollBoxRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import {
  For,
  Show,
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type Accessor,
  type JSX,
} from "solid-js";
import type {
  TranscriptPublicationBatch,
  TranscriptPublicationSectionHeader,
  TranscriptPublicationToolGroup,
} from "../../adapters/transcript-publication.ts";
import { diagnosticEvent } from "../../core/diagnostic-events.ts";
import { tokens } from "../../theme/tokens.ts";
import { asciiMode, glyph } from "../../theme/glyphs.ts";
import { scrollbarOptions, SCROLLBOX_TABLE_GUTTER } from "../../theme/surfaces.ts";
import {
  SyntaxPublicationBoundary,
  type SyntaxPublicationMeasurement,
  waitForStableDimensions,
  waitForSyntaxFrame,
} from "../../ui/patterns/stable-syntax.tsx";
import type { ActivityDetail } from "../activity-detail.ts";
import type { BlockOverride } from "../block-focus.ts";
import { BlockView } from "../blocks.tsx";
import "./TranscriptScrollBox.ts";
import type { TranscriptScrollBoxRenderable } from "./TranscriptScrollBox.ts";
import {
  createPhysicalWindowController,
  TRANSCRIPT_GEOMETRY_MEASUREMENT_OWNER_LIMIT,
  TRANSCRIPT_LAYOUT_EPOCH_STRIDE,
  type TranscriptPhysicalMarker,
  type TranscriptPhysicalWindow,
  type TranscriptMeasurementCommit,
} from "./physical-window.ts";

/** Maximum wait for one hidden syntax preparation before a bounded recovery step. */
const TRANSCRIPT_MEASUREMENT_LEASE_MS = 2_000;

/** One fresh syntax subtree is allowed before the candidate degrades to stable text. */
const TRANSCRIPT_MEASUREMENT_RETRIES = 1;

/** One permanently reserved column keeps scrollbar visibility out of marker identity. */
export const TRANSCRIPT_SCROLLBAR_COLUMNS = 1;

/** ScrollBox content columns unavailable to one direct publication owner. */
const TRANSCRIPT_HISTORY_HORIZONTAL_PADDING = 1 + SCROLLBOX_TABLE_GUTTER;

/** Internal timing policy for one syntax measurement lease. */
export interface TranscriptMeasurementRecoveryPolicy {
  readonly leaseMs: number;
  readonly retries: number;
}

type TranscriptSyntaxPolicy = "rich" | "plain-semantic";

/** User-driven view state accepted by committed history. */
export interface CommittedHistoryState {
  semanticNodes: Accessor<TranscriptPublicationBatch["nodes"]>;
  expandAll: Accessor<boolean>;
  selectedSubagent: Accessor<string | null>;
  focusedKey: Accessor<string | null>;
  overrideOf(key: string): BlockOverride | undefined;
  toggleAt(key: string): void;
}

/** Fold and focus state shared by both physical and handoff publication owners. */
export interface CommittedHistoryBlockPresentation {
  forceExpand: Accessor<boolean>;
  folded(batch: TranscriptPublicationBatch, key: string): boolean;
  focusedKey: Accessor<string | null>;
  overrideOf(key: string): BlockOverride | undefined;
  publications: Accessor<readonly TranscriptPublicationBatch[]>;
  toggleAt(key: string): void;
}

/** Presentation state inherited by the live tail while it owns a frozen handoff snapshot. */
export const CommittedHistoryBlockPresentationContext =
  createContext<CommittedHistoryBlockPresentation>();

/** The only reactive store seam allowed to cross into committed-history ownership. */
export interface CommittedHistoryPublicationStore {
  readonly publicationBatches: readonly TranscriptPublicationBatch[];
}

/** Physical navigation exposed to application key handling. */
export type CommittedHistoryScrollResult = "scrolled" | "preparing" | "start" | "end";

/** Physical navigation exposed to application key handling. */
export interface CommittedHistoryHandle {
  requestEarlier(): boolean;
  requestLater(): boolean;
  returnToTail(): boolean;
  scrollBy(rows: number): CommittedHistoryScrollResult;
  revealKey(key: string): boolean;
  snapshot(): TranscriptPhysicalWindow;
  marker(batchId: string): TranscriptPhysicalMarker | undefined;
  diagnostics(): {
    readonly pendingRevealKey: string | null;
    readonly pendingScrollDelta: number;
    readonly lastCommit: TranscriptMeasurementCommit | null;
    readonly syntaxPolicyCount: number;
    readonly geometryMeasurementOwners: number;
    readonly geometryMeasurementOwnerPeak: number;
    readonly geometryMeasurementOwnerLimit: number;
  };
}

/** Inputs owned by the immutable, physically windowed history surface. */
export interface CommittedHistoryProps {
  store: CommittedHistoryPublicationStore;
  transcript: CommittedHistoryState;
  active?: Accessor<boolean>;
  splitOpen: Accessor<boolean>;
  notify: (message: string) => void;
  onOpenDetail?: (detail: ActivityDetail) => void;
  onScrollbox: (scrollbox: ScrollBoxRenderable) => void;
  onHandle?: (handle: CommittedHistoryHandle | undefined) => void;
  measurementRecovery?: TranscriptMeasurementRecoveryPolicy;
  handoffKeys?: Accessor<ReadonlySet<string>>;
  tail?: (visibleCommittedKeys: Accessor<ReadonlySet<string>>) => JSX.Element;
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

function hashFoldValue(hash: number, value: string): number {
  let next = hash;
  for (let index = 0; index < value.length; index += 1) {
    next ^= value.charCodeAt(index);
    next = Math.imul(next, 16_777_619);
  }
  return next >>> 0;
}

function batchFoldRevision(
  batch: TranscriptPublicationBatch,
  transcript: CommittedHistoryState,
): number {
  let hash = hashFoldValue(2_166_136_261, transcript.expandAll() ? "all:1" : "all:0");
  for (const node of batch.nodes) {
    hash = hashFoldValue(hash, node.key);
    hash = hashFoldValue(hash, transcript.overrideOf(node.key) ?? "default");
    hash = hashFoldValue(hash, batch.defaultFolded[node.key] === true ? "fold:1" : "fold:0");
    hash = hashFoldValue(
      hash,
      sectionFolded(batch, node.key, transcript) ? "section:1" : "section:0",
    );
  }
  return hash;
}

function PhysicalPublicationOwner(props: {
  ownerId?: string;
  batch: TranscriptPublicationBatch;
  transcript: CommittedHistoryState;
  splitOpen: Accessor<boolean>;
  onOpenDetail?: (detail: ActivityDetail) => void;
  active: Accessor<boolean>;
  interactive: Accessor<boolean>;
  measurementOnly?: boolean;
  presentationColumns?: Accessor<number | undefined>;
  ownerTop: Accessor<number>;
  candidateRows: Accessor<number | undefined>;
  measurementToken: Accessor<number | null>;
  foldRevision: Accessor<number>;
  prepaint: Accessor<boolean>;
  syntaxPolicy: TranscriptSyntaxPolicy;
  onSyntaxPolicy: (policy: TranscriptSyntaxPolicy) => void;
  onMeasured: (
    batchId: string,
    foldRevision: number,
    measurementRevision: number,
    measurement: SyntaxPublicationMeasurement,
  ) => boolean;
  measurementRecovery: TranscriptMeasurementRecoveryPolicy;
}): JSX.Element {
  const renderer = useRenderer();
  const [ready, setReady] = createSignal(false);
  const [prepaintVisible, setPrepaintVisible] = createSignal(false);
  const [mountRevision, setMountRevision] = createSignal(1);
  const [allowUnsettledSyntax, setAllowUnsettledSyntax] = createSignal(
    props.syntaxPolicy === "plain-semantic",
  );
  const measurementToken = createMemo(props.measurementToken);
  let owner: Renderable | undefined;
  let observedToken: number | null = null;
  let retries = 0;
  let paintedRecoveryRevision = 0;
  let lease: ReturnType<typeof setTimeout> | undefined;
  let pendingPrepaint:
    | {
        foldRevision: number;
        measurementRevision: number;
        measurement: SyntaxPublicationMeasurement;
      }
    | undefined;
  const clearLease = (): void => {
    if (lease === undefined) return;
    clearTimeout(lease);
    lease = undefined;
  };
  const commitMeasurement = (
    foldRevision: number,
    measurementRevision: number,
    measurement: SyntaxPublicationMeasurement,
  ): boolean => {
    const accepted = props.onMeasured(
      props.batch.id,
      foldRevision,
      measurementRevision,
      measurement,
    );
    diagnosticEvent("transcript.measurement.observed", {
      batch_id: props.batch.id,
      fold_revision: foldRevision,
      columns: measurement.columns,
      rows: measurement.rows,
      accepted,
      fallback: allowUnsettledSyntax(),
    });
    if (!accepted) return false;
    clearLease();
    setReady(true);
    return true;
  };
  const retainPaintedOwner = (token: number): boolean => {
    if (!ready() || owner === undefined || owner.isDestroyed) return false;
    const paintedOwner = owner;
    const captured = ++paintedRecoveryRevision;
    const current = (): boolean =>
      captured === paintedRecoveryRevision &&
      measurementToken() === token &&
      ready() &&
      owner === paintedOwner;
    void waitForSyntaxFrame(paintedOwner, current, renderer)
      .then(() => waitForStableDimensions(paintedOwner, current, renderer))
      .then((measurement) => {
        if (measurement !== null && current())
          commitMeasurement(props.foldRevision(), token, measurement);
      })
      .catch(() => undefined);
    return true;
  };
  const armLease = (token: number): void => {
    clearLease();
    lease = setTimeout(() => {
      lease = undefined;
      if (measurementToken() !== token) return;
      diagnosticEvent("transcript.measurement.lease_expired", {
        batch_id: props.batch.id,
        retry: retries,
        fallback: retries >= props.measurementRecovery.retries,
      });
      if (retainPaintedOwner(token)) return;
      if (retries < props.measurementRecovery.retries) {
        retries += 1;
        setMountRevision((revision) => revision + 1);
        armLease(token);
      } else if (!allowUnsettledSyntax()) {
        props.onSyntaxPolicy("plain-semantic");
        batch(() => {
          setAllowUnsettledSyntax(true);
          setMountRevision((revision) => revision + 1);
        });
      }
      renderer.requestRender();
    }, props.measurementRecovery.leaseMs);
  };
  const finishPrepaint = (): void => {
    renderer.off("frame", finishPrepaint);
    const pending = pendingPrepaint;
    pendingPrepaint = undefined;
    if (pending === undefined) return;
    const accepted = commitMeasurement(
      pending.foldRevision,
      pending.measurementRevision,
      pending.measurement,
    );
    if (!accepted) {
      setReady(false);
      setPrepaintVisible(false);
      return;
    }
    setPrepaintVisible(false);
  };
  createEffect(
    on(measurementToken, (token) => {
      clearLease();
      if (token === observedToken) return;
      observedToken = token;
      paintedRecoveryRevision += 1;
      pendingPrepaint = undefined;
      renderer.off("frame", finishPrepaint);
      if (token === null) return;
      retries = 0;
      diagnosticEvent("transcript.measurement.started", {
        batch_id: props.batch.id,
        fold_revision: props.foldRevision(),
      });
      const retainVisibleOwner = ready();
      batch(() => {
        setReady(retainVisibleOwner);
        setPrepaintVisible(false);
      });
      armLease(token);
    }),
  );
  onCleanup(() => {
    paintedRecoveryRevision += 1;
    clearLease();
    renderer.off("frame", finishPrepaint);
  });
  const visible = (): boolean =>
    ready() && (props.active() || measurementToken() !== null || prepaintVisible());
  const acceptMeasurement = (
    measurement: SyntaxPublicationMeasurement,
    measurementRevision: number | undefined,
  ): boolean => {
    if (measurementRevision === undefined) return false;
    const foldRevision = props.foldRevision();
    if (!props.prepaint()) return commitMeasurement(foldRevision, measurementRevision, measurement);
    clearLease();
    pendingPrepaint = { foldRevision, measurementRevision, measurement };
    batch(() => {
      setReady(true);
      setPrepaintVisible(true);
    });
    renderer.off("frame", finishPrepaint);
    renderer.on("frame", finishPrepaint);
    queueMicrotask(() => renderer.requestRender());
    return true;
  };
  const group = (key: string): TranscriptPublicationToolGroup | undefined =>
    props.batch.toolGroups[key];
  const header = (key: string): TranscriptPublicationSectionHeader | undefined =>
    props.batch.sectionHeaders[key];

  return (
    <box
      id={props.ownerId ?? `history:${props.batch.id}`}
      ref={(value: Renderable) => {
        owner = value;
      }}
      onMouse={(event) => {
        if (props.interactive()) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      flexDirection="column"
      width="100%"
      maxWidth={props.presentationColumns?.()}
      minWidth={0}
      position={props.active() ? "relative" : "absolute"}
      left={0}
      top={props.active() ? 0 : props.ownerTop()}
      height={props.active() ? undefined : props.candidateRows()}
      minHeight={props.active() ? undefined : 1}
      flexShrink={0}
      zIndex={!props.measurementOnly && (props.active() || prepaintVisible()) ? 0 : -1}
      opacity={!props.measurementOnly && visible() ? 1 : 0}
    >
      <Show when={mountRevision()} keyed>
        {(_mountRevision: number) => (
          <SyntaxPublicationBoundary
            allowUnsettled={allowUnsettledSyntax() && !ready()}
            diagnosticId={props.batch.id}
            measurementRevision={measurementToken() ?? undefined}
            onReady={acceptMeasurement}
          >
            <For each={props.batch.nodes}>
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
          </SyntaxPublicationBoundary>
        )}
      </Show>
    </box>
  );
}

/**
 * Renders frozen publication batches through a physically measured OpenTUI window.
 *
 * @remarks Every resident batch is a direct ScrollBox content child. Off-window
 * owners are unmounted, while exact current-epoch marker sums retain scroll
 * geometry. The sole adjacent candidate stays transparent until syntax and two
 * equal physical observations settle. Viewport culling is suspended only for
 * that interval because OpenTUI skips required render hooks on culled children;
 * the same owner then enters relative chronological flow. Geometry changes keep
 * those visible owners at their painted marker widths while one non-interactive
 * clone serially stages the replacement epoch for an atomic swap.
 */
export function CommittedHistory(props: CommittedHistoryProps): JSX.Element {
  const renderer = useRenderer();
  const terminalDimensions = useTerminalDimensions();
  const controller = createPhysicalWindowController();
  const active = (): boolean => props.active?.() ?? true;
  const syntaxPolicyByBatchId = new Map<string, TranscriptSyntaxPolicy>();
  const measurementRecovery = Object.freeze({
    leaseMs: Math.max(
      1,
      Math.trunc(props.measurementRecovery?.leaseMs ?? TRANSCRIPT_MEASUREMENT_LEASE_MS),
    ),
    retries: Math.max(
      0,
      Math.trunc(props.measurementRecovery?.retries ?? TRANSCRIPT_MEASUREMENT_RETRIES),
    ),
  });
  const [scrollbox, setScrollbox] = createSignal<TranscriptScrollBoxRenderable>();
  const [physical, setPhysical] = createSignal(controller.snapshot());
  const [presentationLock, setPresentationLock] = createSignal<{
    readonly layoutEpoch: number;
  } | null>(null);
  let frameQueued = false;
  let pendingRevealKey: string | null = null;
  let pendingRevealBatchId: string | null = null;
  let pendingRevealPlaced = false;
  let lastCommit: TranscriptMeasurementCommit | null = null;
  let geometryMeasurementOwners = 0;
  let geometryMeasurementOwnerPeak = 0;

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
  const syntaxPolicyOf = (batchId: string): TranscriptSyntaxPolicy => {
    const existing = syntaxPolicyByBatchId.get(batchId);
    if (existing !== undefined) return existing;
    syntaxPolicyByBatchId.set(batchId, "rich");
    return "rich";
  };
  const rememberSyntaxPolicy = (batchId: string, policy: TranscriptSyntaxPolicy): void => {
    if (syntaxPolicyByBatchId.get(batchId) === "plain-semantic") return;
    syntaxPolicyByBatchId.set(batchId, policy);
  };
  createEffect(() => {
    const retained = new Set(props.store.publicationBatches.map((batch) => batch.id));
    for (const batchId of syntaxPolicyByBatchId.keys())
      if (!retained.has(batchId)) syntaxPolicyByBatchId.delete(batchId);
  });
  const batchesById = createMemo(
    () => new Map(semanticBatches().map((batch) => [batch.id, batch] as const)),
  );
  const foldRevisionOf = (batchId: string): number => {
    const batch = batchesById().get(batchId);
    return batch === undefined ? 0 : batchFoldRevision(batch, props.transcript);
  };
  const activeIds = createMemo(() => new Set(physical().activeBatchIds));
  const visibleCommittedKeys = createMemo<ReadonlySet<string>>(() => {
    const ids = activeIds();
    return new Set(
      semanticBatches()
        .filter((publication) => ids.has(publication.id))
        .flatMap((publication) => publication.nodes.map((node) => node.key)),
    );
  });
  const mountedBatches = createMemo(() => {
    const ids = new Set(physical().activeBatchIds);
    const candidate = physical().candidate;
    if (candidate !== null) ids.add(candidate.batchId);
    return semanticBatches().filter((batch) => ids.has(batch.id));
  });
  const geometryCandidate = createMemo(() => {
    const snapshot = physical();
    const candidate = snapshot.candidate;
    if (
      !snapshot.geometryTransition ||
      candidate === null ||
      !candidate.resident ||
      candidate.reason !== "remeasure"
    )
      return undefined;
    return batchesById().get(candidate.batchId);
  });
  const handoffCandidate = createMemo(() => {
    const candidate = physical().candidate;
    if (candidate === null || candidate.resident || !physical().followingTail) return null;
    const publication = batchesById().get(candidate.batchId);
    return publication?.nodes.some((node) => props.handoffKeys?.().has(node.key) === true)
      ? candidate
      : null;
  });
  const earlierEntries = createMemo(() => {
    const candidate = handoffCandidate();
    return Math.max(
      0,
      physical().earlierUnknown -
        (candidate !== null && candidate.index < physical().start ? 1 : 0),
    );
  });
  const laterEntries = createMemo(() => {
    const candidate = handoffCandidate();
    return Math.max(
      0,
      physical().batchIds.length -
        physical().end -
        (candidate !== null && candidate.index >= physical().end ? 1 : 0),
    );
  });
  const flowTailRow = (): number =>
    (earlierEntries() > 0 ? 1 : 0) +
    physical().beforeRows +
    physical().activeRows +
    physical().afterRows;

  const publish = (): void => {
    setPhysical(controller.snapshot());
  };
  const synchronize = (): boolean => {
    if (!active()) return false;
    const element = scrollbox();
    return controller.sync({
      batchIds: semanticBatches().map((batch) => batch.id),
      columns: element?.content.width ?? 1,
      glyphMode: asciiMode() ? "ascii" : "unicode",
      viewportRows: element?.viewport.height ?? 1,
      foldRevisionOf,
    });
  };
  const requestRender = (): void => {
    publish();
    renderer.requestRender();
  };
  const synchronizeScrollbar = (element: ScrollBoxRenderable): void => {
    const opacity = element.scrollHeight > element.viewport.height ? 1 : 0;
    if (element.verticalScrollBar.opacity !== opacity) element.verticalScrollBar.opacity = opacity;
  };
  const clearPendingReveal = (): void => {
    const batchId = pendingRevealBatchId;
    pendingRevealKey = null;
    pendingRevealBatchId = null;
    pendingRevealPlaced = false;
    if (batchId !== null) controller.releaseEnsuredBatch(batchId);
  };
  const returnToTail = (): boolean => {
    clearPendingReveal();
    scrollbox()?.clearPhysicalScrollDelta();
    const changed = controller.returnToTail();
    const element = scrollbox();
    if (element !== undefined) {
      const snapshot = controller.snapshot();
      const tailReady = snapshot.candidate === null && snapshot.end >= snapshot.batchIds.length;
      element.stickyScroll = tailReady;
      if (tailReady)
        element.scrollTo({
          x: 0,
          y: Math.max(0, element.scrollHeight - element.viewport.height),
        });
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
    if (batch === undefined) {
      clearPendingReveal();
      return;
    }
    if (!controller.snapshot().activeBatchIds.includes(batch.id)) return;
    const row = controller.rowOf(batch.id);
    if (row === undefined) return;
    element.stickyScroll = false;
    if (!pendingRevealPlaced) {
      const maxScrollTop = Math.max(0, element.scrollHeight - element.viewport.height);
      element.scrollTo({ x: 0, y: Math.min(row, maxScrollTop) });
      pendingRevealPlaced = true;
      renderer.requestRender();
      return;
    }
    const targetId =
      element.content.findDescendantById(key) === undefined ? `history:${batch.id}` : key;
    element.scrollChildIntoView(targetId);
    clearPendingReveal();
  };
  const observeFrame = (): void => {
    const element = scrollbox();
    if (element === undefined || renderer.isDestroyed || !active()) return;
    synchronizeScrollbar(element);
    let changed = synchronize();
    revealPending();
    changed =
      controller.observe({
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        viewportRows: element.viewport.height,
      }) || changed;
    const lock = presentationLock();
    const observed = controller.snapshot();
    if (lock !== null && !observed.geometryTransition && observed.layoutEpoch > lock.layoutEpoch)
      setPresentationLock(null);
    if (
      pendingRevealKey === null &&
      controller.snapshot().followingTail &&
      element.scrollTop >= Math.max(0, element.scrollHeight - element.viewport.height - 1)
    )
      element.stickyScroll = true;
    if (changed) publish();
    if (changed) renderer.requestRender();
  };
  const queueFrameObservation = (): void => {
    if (frameQueued) return;
    frameQueued = true;
    queueMicrotask(() => {
      frameQueued = false;
      observeFrame();
    });
  };

  createEffect(
    on(
      () => `${terminalDimensions().width}:${String(props.splitOpen())}`,
      () => {
        const snapshot = controller.snapshot();
        if (snapshot.activeBatchIds.length === 0) return;
        setPresentationLock({ layoutEpoch: snapshot.layoutEpoch });
        renderer.requestRender();
      },
      { defer: true },
    ),
  );

  const scrollBy = (requestedRows: number): CommittedHistoryScrollResult => {
    const element = scrollbox();
    const rows = Math.trunc(requestedRows);
    if (element === undefined || rows === 0) return "scrolled";
    if (rows < 0) controller.setFollowingTail(false);
    const snapshot = controller.snapshot();
    const firstId = snapshot.activeBatchIds[0];
    const activeStart = firstId === undefined ? undefined : controller.rowOf(firstId);
    if (activeStart === undefined) {
      const accepted = rows < 0 ? controller.requestEarlier() : controller.requestLater();
      if (accepted) requestRender();
      return accepted ? "preparing" : rows < 0 ? "start" : "end";
    }

    element.stickyScroll = false;
    const activeEnd = activeStart + snapshot.activeRows;
    const lastStart = Math.max(activeStart, activeEnd - element.viewport.height);
    const current = Math.max(activeStart, Math.min(lastStart, element.scrollTop));
    const target = current + rows;
    if (rows < 0 && target < activeStart) {
      if (element.scrollTop !== activeStart) element.scrollTo({ x: 0, y: activeStart });
      const accepted = controller.requestEarlier();
      if (accepted) requestRender();
      return accepted ? "preparing" : "start";
    }
    if (rows > 0 && target > lastStart) {
      if (element.scrollTop !== lastStart) element.scrollTo({ x: 0, y: lastStart });
      const accepted = controller.requestLater();
      if (accepted) requestRender();
      else {
        controller.setFollowingTail(true);
        element.stickyScroll = true;
      }
      return accepted ? "preparing" : "end";
    }

    const nextTop = Math.max(activeStart, Math.min(lastStart, target));
    element.scrollTo({ x: 0, y: nextTop });
    if (rows > 0 && nextTop >= lastStart && snapshot.end >= snapshot.batchIds.length) {
      controller.setFollowingTail(true);
      element.stickyScroll = true;
    }
    renderer.requestRender();
    return "scrolled";
  };

  const onVerticalScrollIntent = (direction: "up" | "down"): void => {
    const element = scrollbox();
    if (element === undefined || !active()) return;
    if (direction === "up") {
      controller.setFollowingTail(false);
      element.stickyScroll = false;
      controller.prefetchEarlier();
    } else {
      controller.prefetchLater();
      const snapshot = controller.snapshot();
      const maxScrollTop = Math.max(0, element.scrollHeight - element.viewport.height);
      if (element.scrollTop >= maxScrollTop - 1) {
        if (snapshot.end < snapshot.batchIds.length) controller.prefetchLater();
        else {
          controller.setFollowingTail(true);
          element.stickyScroll = true;
        }
      }
    }
    publish();
    queueFrameObservation();
    renderer.requestRender();
  };

  const handle: CommittedHistoryHandle = {
    requestEarlier: () => {
      const element = scrollbox();
      if (element !== undefined) element.stickyScroll = false;
      const accepted = controller.requestEarlier();
      if (accepted) requestRender();
      return accepted;
    },
    scrollBy,
    returnToTail,
    requestLater: () => {
      const element = scrollbox();
      const accepted = controller.requestLater();
      if (accepted) {
        if (element !== undefined) element.stickyScroll = false;
        requestRender();
      } else if (element !== undefined) {
        controller.setFollowingTail(true);
        element.stickyScroll = true;
      }
      return accepted;
    },
    revealKey: (key) => {
      const batch = semanticBatches().find((candidate) =>
        candidate.nodes.some((node) => node.key === key),
      );
      if (batch === undefined) return false;
      clearPendingReveal();
      pendingRevealKey = key;
      pendingRevealBatchId = batch.id;
      pendingRevealPlaced = false;
      const element = scrollbox();
      controller.setFollowingTail(false);
      if (element !== undefined) element.stickyScroll = false;
      const accepted = controller.ensureBatch(batch.id);
      if (accepted) requestRender();
      revealPending();
      return accepted;
    },
    snapshot: () => controller.snapshot(),
    marker: (batchId) => controller.marker(batchId),
    diagnostics: () => ({
      pendingRevealKey,
      pendingScrollDelta: scrollbox()?.pendingPhysicalScrollDelta ?? 0,
      lastCommit,
      syntaxPolicyCount: syntaxPolicyByBatchId.size,
      geometryMeasurementOwners,
      geometryMeasurementOwnerPeak,
      geometryMeasurementOwnerLimit: TRANSCRIPT_GEOMETRY_MEASUREMENT_OWNER_LIMIT,
    }),
  };

  createEffect(() => {
    if (!active()) {
      if (controller.cancelMeasurement()) requestRender();
      return;
    }
    semanticBatches();
    props.transcript.expandAll();
    for (const batch of semanticBatches()) foldRevisionOf(batch.id);
    if (synchronize()) requestRender();
  });

  renderer.on("frame", queueFrameObservation);
  props.onHandle?.(handle);
  onCleanup(() => {
    renderer.off("frame", queueFrameObservation);
    props.onHandle?.(undefined);
  });

  const measure = (
    batchId: string,
    foldRevision: number,
    measurementRevision: number,
    measurement: SyntaxPublicationMeasurement,
  ): boolean => {
    if (!active()) return false;
    const returningToTail = controller.snapshot().candidate?.reason === "return-tail";
    const result = controller.commitMeasurement({
      batchId,
      columns: measurement.columns,
      rows: measurement.rows,
      foldRevision,
      measurementRevision,
    });
    lastCommit = result;
    if (!result.accepted) return false;
    if (returningToTail) {
      const element = scrollbox();
      if (element !== undefined) element.stickyScroll = true;
    }
    scrollbox()?.queuePhysicalScrollDelta(result.anchorDelta + result.navigationDelta);
    requestRender();
    return true;
  };

  const setScrollboxRef = (value: TranscriptScrollBoxRenderable): void => {
    value.verticalScrollBar.visible = true;
    synchronizeScrollbar(value);
    setScrollbox(value);
    props.onScrollbox(value);
    if (synchronize()) requestRender();
  };
  const GeometryMeasurementOwner = (ownerProps: {
    batch: TranscriptPublicationBatch;
  }): JSX.Element => {
    onMount(() => {
      geometryMeasurementOwners += 1;
      geometryMeasurementOwnerPeak = Math.max(
        geometryMeasurementOwnerPeak,
        geometryMeasurementOwners,
      );
    });
    onCleanup(() => {
      geometryMeasurementOwners = Math.max(0, geometryMeasurementOwners - 1);
    });
    return (
      <PhysicalPublicationOwner
        ownerId={`history-geometry-candidate:${ownerProps.batch.id}`}
        batch={ownerProps.batch}
        transcript={props.transcript}
        splitOpen={props.splitOpen}
        onOpenDetail={props.onOpenDetail}
        active={() => false}
        interactive={() => false}
        measurementOnly
        ownerTop={() => physical().scrollTop + physical().viewportRows + 1}
        candidateRows={() => undefined}
        measurementToken={() =>
          physical().layoutEpoch * TRANSCRIPT_LAYOUT_EPOCH_STRIDE +
          foldRevisionOf(ownerProps.batch.id)
        }
        foldRevision={() => foldRevisionOf(ownerProps.batch.id)}
        prepaint={() => false}
        syntaxPolicy={syntaxPolicyOf(ownerProps.batch.id)}
        onSyntaxPolicy={() => undefined}
        onMeasured={measure}
        measurementRecovery={measurementRecovery}
      />
    );
  };
  const tailBlockPresentation: CommittedHistoryBlockPresentation = {
    forceExpand: () => props.transcript.expandAll(),
    folded: (publication, key) => sectionFolded(publication, key, props.transcript),
    focusedKey: () => props.transcript.focusedKey(),
    overrideOf: (key) => props.transcript.overrideOf(key),
    publications: semanticBatches,
    toggleAt: (key) => props.transcript.toggleAt(key),
  };

  return (
    <transcript_scrollbox
      id="committed-history"
      ref={setScrollboxRef}
      stickyScroll
      stickyStart="bottom"
      viewportCulling={physical().candidate === null}
      flexGrow={1}
      minHeight={0}
      paddingLeft={1}
      paddingRight={SCROLLBOX_TABLE_GUTTER}
      contentOptions={{ alignItems: "flex-start" }}
      verticalScrollbarOptions={{
        ...scrollbarOptions(),
        width: TRANSCRIPT_SCROLLBAR_COLUMNS,
      }}
      onVerticalScrollIntent={onVerticalScrollIntent}
    >
      <Show when={earlierEntries() > 0}>
        <box id="history-boundary-earlier" height={1} flexShrink={0} paddingLeft={1}>
          <text fg={tokens.muted} wrapMode="none" truncate selectable={false}>
            {`${glyph("caretUp")} ${earlierEntries()} earlier entr${earlierEntries() === 1 ? "y" : "ies"} ${glyph("emDash")} scroll to load`}
          </text>
        </box>
      </Show>
      <Show when={physical().beforeRows > 0}>
        <box id="history-spacer-before" height={physical().beforeRows} flexShrink={0} />
      </Show>
      <For each={mountedBatches()}>
        {(batch) => (
          <PhysicalPublicationOwner
            batch={batch}
            transcript={props.transcript}
            splitOpen={props.splitOpen}
            onOpenDetail={props.onOpenDetail}
            active={() => activeIds().has(batch.id)}
            interactive={() => active() && activeIds().has(batch.id)}
            presentationColumns={() => {
              if (presentationLock() === null) return undefined;
              const columns = controller.marker(batch.id)?.columns;
              return columns === undefined
                ? undefined
                : Math.max(1, columns - TRANSCRIPT_HISTORY_HORIZONTAL_PADDING);
            }}
            ownerTop={() =>
              activeIds().has(batch.id)
                ? (controller.rowOf(batch.id) ?? 0)
                : handoffCandidate()?.batchId === batch.id
                  ? flowTailRow()
                  : physical().scrollTop + physical().viewportRows + 1
            }
            candidateRows={() =>
              physical().candidate?.batchId === batch.id
                ? controller.marker(batch.id)?.rows
                : undefined
            }
            measurementToken={() => {
              const candidate = physical().candidate;
              if (
                physical().geometryTransition &&
                candidate?.resident === true &&
                candidate.batchId === batch.id
              )
                return null;
              return candidate?.batchId === batch.id
                ? physical().layoutEpoch * TRANSCRIPT_LAYOUT_EPOCH_STRIDE + foldRevisionOf(batch.id)
                : null;
            }}
            foldRevision={() => foldRevisionOf(batch.id)}
            prepaint={() => handoffCandidate()?.batchId === batch.id}
            syntaxPolicy={syntaxPolicyOf(batch.id)}
            onSyntaxPolicy={(policy) => rememberSyntaxPolicy(batch.id, policy)}
            onMeasured={measure}
            measurementRecovery={measurementRecovery}
          />
        )}
      </For>
      <For each={geometryCandidate() === undefined ? [] : [geometryCandidate()!]}>
        {(batch) => <GeometryMeasurementOwner batch={batch} />}
      </For>
      <Show when={physical().afterRows > 0}>
        <box id="history-spacer-after" height={physical().afterRows} flexShrink={0} />
      </Show>
      <Show when={physical().followingTail}>
        <CommittedHistoryBlockPresentationContext.Provider value={tailBlockPresentation}>
          {props.tail?.(visibleCommittedKeys)}
        </CommittedHistoryBlockPresentationContext.Provider>
      </Show>
      <Show when={laterEntries() > 0 && !physical().followingTail}>
        <box
          id="history-newer-indicator"
          position="absolute"
          left={1}
          top={physical().scrollTop}
          height={1}
          zIndex={3}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={tokens.bgElev}
        >
          <text fg={tokens.accent2} wrapMode="none" truncate selectable={false}>
            {`${glyph("caretDown")} ${laterEntries()} newer entr${laterEntries() === 1 ? "y" : "ies"}`}
          </text>
        </box>
      </Show>
    </transcript_scrollbox>
  );
}
