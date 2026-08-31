/** Complete viewport heights prepared in the current scroll direction. */
export const TRANSCRIPT_PREFETCH_AHEAD_VIEWPORTS = 2;

/** Complete viewport heights retained behind the current scroll direction. */
export const TRANSCRIPT_RETAIN_BEHIND_VIEWPORTS = 1;

/** Physical measurement is deliberately serialized to one native owner. */
export const TRANSCRIPT_MEASURE_CONCURRENCY = 1;

/** A width transition may mount only one hidden geometry clone at a time. */
export const TRANSCRIPT_GEOMETRY_MEASUREMENT_OWNER_LIMIT = 1;

/** Keeps one layout epoch disjoint from every 32-bit fold revision. */
export const TRANSCRIPT_LAYOUT_EPOCH_STRIDE = 4_294_967_296;

/** Why one batch is being observed by the physical-window controller. */
export type TranscriptMeasurementReason =
  | "fill"
  | "initial"
  | "navigate-earlier"
  | "navigate-later"
  | "prefetch-earlier"
  | "prefetch-later"
  | "remeasure"
  | "return-tail";

/** Direction whose adjacent physical owners receive the longer prepared runway. */
export type TranscriptPrefetchDirection = "earlier" | "later";

/** The physical identity of one batch in one layout epoch. */
export interface TranscriptPhysicalMarker {
  readonly batchId: string;
  readonly layoutEpoch: number;
  readonly columns: number;
  readonly foldRevision: number;
  readonly rows: number;
}

/** The only native owner currently admitted for physical observation. */
export interface TranscriptMeasurementCandidate {
  readonly batchId: string;
  readonly index: number;
  readonly reason: TranscriptMeasurementReason;
  readonly top: number;
  readonly resident: boolean;
}

/** Immutable projection consumed by the Solid ScrollBox owner. */
export interface TranscriptPhysicalWindow {
  readonly batchIds: readonly string[];
  readonly start: number;
  readonly end: number;
  readonly activeBatchIds: readonly string[];
  readonly activeRows: number;
  readonly beforeRows: number;
  readonly afterRows: number;
  readonly earlierUnknown: number;
  readonly laterUnknown: number;
  readonly candidate: TranscriptMeasurementCandidate | null;
  readonly layoutEpoch: number;
  /** Width currently painted by resident owners while a replacement epoch settles. */
  readonly displayColumns: number;
  /** True while one serial hidden clone prepares the replacement width. */
  readonly geometryTransition: boolean;
  readonly columns: number;
  readonly viewportRows: number;
  readonly scrollTop: number;
  readonly followingTail: boolean;
  readonly prefetchDirection: TranscriptPrefetchDirection;
}

/** Exact scroll corrections produced by one accepted physical observation. */
export interface TranscriptMeasurementCommit {
  readonly accepted: boolean;
  readonly anchorDelta: number;
  readonly navigationDelta: number;
}

interface CandidateState extends TranscriptMeasurementCandidate {
  readonly requestedFoldRevision: number;
  readonly requestedMeasurementRevision: number;
  readonly previousRows: number;
}

interface ReaderAnchor {
  readonly batchId: string;
  readonly rowOffset: number;
}

interface GeometryTransitionState {
  readonly anchor: ReaderAnchor | null;
  readonly batchIds: readonly string[];
  readonly markers: Map<string, TranscriptPhysicalMarker>;
}

function positiveInteger(value: number): number {
  return Math.max(1, Math.trunc(Number.isFinite(value) ? value : 1));
}

function samePrefix(previous: readonly string[], next: readonly string[]): boolean {
  if (next.length < previous.length) return false;
  return previous.every((id, index) => next[index] === id);
}

function contiguousIndex(haystack: readonly string[], needles: readonly string[]): number {
  if (needles.length === 0) return -1;
  const start = haystack.indexOf(needles[0]!);
  if (start < 0) return -1;
  return needles.every((id, offset) => haystack[start + offset] === id) ? start : -1;
}

function contiguousRangeAround(
  previous: readonly string[],
  next: readonly string[],
  anchorId: string,
): { start: number; end: number } | null {
  let previousStart = previous.indexOf(anchorId);
  let nextStart = next.indexOf(anchorId);
  if (previousStart < 0 || nextStart < 0) return null;
  let previousEnd = previousStart + 1;
  let nextEnd = nextStart + 1;

  while (
    previousStart > 0 &&
    nextStart > 0 &&
    previous[previousStart - 1] === next[nextStart - 1]
  ) {
    previousStart -= 1;
    nextStart -= 1;
  }
  while (
    previousEnd < previous.length &&
    nextEnd < next.length &&
    previous[previousEnd] === next[nextEnd]
  ) {
    previousEnd += 1;
    nextEnd += 1;
  }
  return { start: nextStart, end: nextEnd };
}

/**
 * Owns a bounded, row-measured window over immutable transcript batches.
 *
 * @remarks Renderer objects never cross this boundary. OpenTUI supplies actual
 * settled dimensions through {@link commitMeasurement}; this class retains only
 * the current marker epoch, admits one adjacent owner and derives exact spacers.
 */
export class PhysicalTranscriptWindowController {
  #batchIds: readonly string[] = Object.freeze([]);
  #markers = new Map<string, TranscriptPhysicalMarker>();
  #lastRows = new Map<string, number>();
  #foldRevisions = new Map<string, number>();
  #start = 0;
  #end = 0;
  #candidate: CandidateState | null = null;
  #pendingReaderAnchor: ReaderAnchor | null = null;
  #geometryTransition: GeometryTransitionState | null = null;
  #returnTailAfterGeometry = false;
  #queuedNavigation: "earlier" | "later" | null = null;
  #ensuredIndex: number | null = null;
  #followingTail = true;
  #prefetchDirection: TranscriptPrefetchDirection = "earlier";
  #layoutEpoch = 0;
  #columns = 1;
  #displayColumns = 1;
  #glyphMode: "ascii" | "unicode" = "unicode";
  #viewportRows = 1;
  #scrollTop = 0;

  /** Synchronize semantic order and every geometry-affecting layout input. */
  sync(input: {
    batchIds: readonly string[];
    columns: number;
    glyphMode: "ascii" | "unicode";
    viewportRows: number;
    foldRevisionOf?: (batchId: string) => number;
  }): boolean {
    const nextIds = Object.freeze([...input.batchIds]);
    const columns = positiveInteger(input.columns);
    const viewportRows = positiveInteger(input.viewportRows);
    const previousIds = this.#batchIds;
    const previousActive = previousIds.slice(this.#start, this.#end);
    const previousLength = previousIds.length;
    const appended = samePrefix(previousIds, nextIds);
    const geometryChanged = columns !== this.#columns || input.glyphMode !== this.#glyphMode;
    const readerAnchor = !this.#followingTail
      ? (this.#geometryTransition?.anchor ?? this.#pendingReaderAnchor ?? this.#readerAnchor())
      : null;
    let changed = viewportRows !== this.#viewportRows;

    this.#viewportRows = viewportRows;
    if (previousLength === 0 && nextIds.length > 0) {
      this.#start = nextIds.length;
      this.#end = nextIds.length;
      this.#candidate = null;
      this.#pendingReaderAnchor = null;
      changed = true;
    } else if (!appended) {
      const readerRange =
        readerAnchor === null
          ? null
          : contiguousRangeAround(previousActive, nextIds, readerAnchor.batchId);
      const preservedStart = readerRange === null ? contiguousIndex(nextIds, previousActive) : -1;
      if (readerRange !== null) {
        this.#start = readerRange.start;
        this.#end = readerRange.end;
        this.#pendingReaderAnchor = readerAnchor;
      } else if (preservedStart >= 0) {
        this.#start = preservedStart;
        this.#end = preservedStart + previousActive.length;
        this.#pendingReaderAnchor = null;
      } else {
        this.#start = nextIds.length;
        this.#end = nextIds.length;
        this.#pendingReaderAnchor = null;
      }
      this.#candidate = null;
      this.#ensuredIndex = null;
      this.#queuedNavigation = null;
      if (this.#geometryTransition !== null) {
        this.#displayColumns = this.#columns;
        this.#markers.clear();
      }
      this.#geometryTransition = null;
      this.#returnTailAfterGeometry = false;
      changed = true;
    } else if (nextIds.length !== previousLength) changed = true;

    this.#batchIds = nextIds;
    const currentIds = new Set(nextIds);
    for (const id of this.#markers.keys()) {
      if (!currentIds.has(id)) this.#markers.delete(id);
    }
    for (const id of this.#lastRows.keys()) {
      if (!currentIds.has(id)) this.#lastRows.delete(id);
    }
    for (const id of this.#foldRevisions.keys()) {
      if (!currentIds.has(id)) this.#foldRevisions.delete(id);
    }
    if (this.#pendingReaderAnchor !== null && !currentIds.has(this.#pendingReaderAnchor.batchId))
      this.#pendingReaderAnchor = null;

    if (geometryChanged) {
      this.#layoutEpoch += 1;
      this.#columns = columns;
      this.#glyphMode = input.glyphMode;
      this.#candidate = null;
      this.#pendingReaderAnchor = null;
      const activeIds = nextIds.slice(this.#start, this.#end);
      if (activeIds.length > 0 && activeIds.every((batchId) => this.#markers.has(batchId))) {
        this.#geometryTransition = {
          anchor: readerAnchor,
          batchIds: Object.freeze(activeIds),
          markers: new Map(),
        };
      } else {
        this.#geometryTransition = null;
        this.#markers.clear();
        this.#displayColumns = columns;
      }
      changed = true;
    }

    const foldRevisionOf = input.foldRevisionOf ?? (() => 0);
    let foldChangedDuringGeometry = false;
    for (const id of nextIds) {
      const revision = Math.max(0, Math.trunc(foldRevisionOf(id)));
      const previous = this.#foldRevisions.get(id);
      this.#foldRevisions.set(id, revision);
      if (previous !== undefined && previous !== revision) {
        this.#markers.delete(id);
        if (this.#candidate?.batchId === id) this.#candidate = null;
        if (this.#geometryTransition !== null) foldChangedDuringGeometry = true;
        changed = true;
      }
    }
    if (foldChangedDuringGeometry) {
      this.#geometryTransition = null;
      this.#returnTailAfterGeometry = false;
      this.#displayColumns = this.#columns;
      this.#markers.clear();
      this.#candidate = null;
    }

    if (
      appended &&
      nextIds.length > previousLength &&
      this.#start === this.#end &&
      this.#candidate?.reason === "initial" &&
      this.#ensuredIndex === null &&
      this.#queuedNavigation === null
    ) {
      this.#candidate = null;
      this.#pendingReaderAnchor = null;
      changed = this.#schedule(nextIds.length - 1, "initial") || changed;
    }

    if (nextIds.length === 0) {
      if (this.#start !== 0 || this.#end !== 0 || this.#candidate !== null) changed = true;
      this.#start = 0;
      this.#end = 0;
      this.#candidate = null;
      this.#ensuredIndex = null;
      this.#queuedNavigation = null;
      this.#geometryTransition = null;
      this.#returnTailAfterGeometry = false;
      this.#displayColumns = columns;
      this.#followingTail = true;
      this.#prefetchDirection = "earlier";
      return changed;
    }

    this.#start = Math.min(this.#start, nextIds.length);
    this.#end = Math.max(this.#start, Math.min(this.#end, nextIds.length));
    const pendingReaderAnchor = this.#pendingReaderAnchor;
    const readerAnchorIndex =
      pendingReaderAnchor === null ? -1 : nextIds.indexOf(pendingReaderAnchor.batchId);
    if (readerAnchorIndex < this.#start || readerAnchorIndex >= this.#end)
      this.#pendingReaderAnchor = null;
    else if (pendingReaderAnchor !== null) this.#markers.delete(pendingReaderAnchor.batchId);
    if (this.#candidate === null) {
      if (this.#geometryTransition !== null) {
        changed = this.#scheduleGeometryMeasurement() || changed;
      } else if (this.#pendingReaderAnchor !== null) {
        changed = this.#schedule(readerAnchorIndex, "remeasure") || changed;
      } else {
        const missingResident = this.#missingResidentIndex();
        if (missingResident !== null) {
          changed = this.#schedule(missingResident, "remeasure") || changed;
        } else if (this.#start === this.#end) {
          changed = this.#schedule(nextIds.length - 1, "initial") || changed;
        } else if (this.#followingTail && this.#end < nextIds.length) {
          changed = this.#schedule(this.#end, "prefetch-later") || changed;
        }
      }
    }
    return changed;
  }

  /** Observe the ScrollBox after a completed renderer frame. */
  observe(input: { scrollTop: number; scrollHeight: number; viewportRows: number }): boolean {
    const previousViewport = this.#viewportRows;
    const previousScrollTop = this.#scrollTop;
    this.#viewportRows = positiveInteger(input.viewportRows);
    this.#scrollTop = Math.max(0, Math.trunc(input.scrollTop));
    let changed = previousViewport !== this.#viewportRows || previousScrollTop !== this.#scrollTop;
    if (this.#scrollTop < previousScrollTop && this.#prefetchDirection !== "earlier") {
      this.#prefetchDirection = "earlier";
      changed = true;
    } else if (
      this.#scrollTop > previousScrollTop &&
      !this.#followingTail &&
      this.#prefetchDirection !== "later"
    ) {
      this.#prefetchDirection = "later";
      changed = true;
    }

    if (this.#candidate !== null) return changed;
    if (this.#geometryTransition !== null) return this.#scheduleGeometryMeasurement() || changed;
    if (this.#start === this.#end) {
      return this.#schedule(this.#batchIds.length - 1, "initial") || changed;
    }

    const missingResident = this.#missingResidentIndex();
    if (missingResident !== null) return this.#schedule(missingResident, "remeasure") || changed;

    if (this.#ensuredIndex !== null) {
      if (this.#ensuredIndex < this.#start)
        return this.#schedule(this.#start - 1, "prefetch-earlier") || changed;
      if (this.#ensuredIndex >= this.#end)
        return this.#schedule(this.#end, "prefetch-later") || changed;
      return changed;
    }

    if (
      this.#followingTail &&
      this.#end >= this.#batchIds.length &&
      this.#prefetchDirection !== "earlier"
    ) {
      this.#prefetchDirection = "earlier";
      changed = true;
    }
    if (this.#scheduleDirectionalPrefetch()) return true;

    return this.#trimOutsideRunway() || changed;
  }

  /** Request the next physically adjacent older batch. */
  requestEarlier(): boolean {
    this.#followingTail = false;
    this.#prefetchDirection = "earlier";
    if (this.#start <= 0) return false;
    if (this.#candidate !== null) {
      if (
        this.#candidate.index === this.#start - 1 &&
        !this.#candidate.resident &&
        this.#candidate.reason !== "initial"
      ) {
        this.#candidate = Object.freeze({ ...this.#candidate, reason: "navigate-earlier" });
        this.#queuedNavigation = null;
      } else {
        this.#queuedNavigation = "earlier";
      }
      return true;
    }
    return this.#schedule(this.#start - 1, "navigate-earlier");
  }

  /** Admit older geometry for native wheel/trackpad scrolling without a page jump. */
  prefetchEarlier(): boolean {
    this.#followingTail = false;
    const changed = this.#prefetchDirection !== "earlier";
    this.#prefetchDirection = "earlier";
    if (this.#candidate !== null) return changed || this.#candidate.index === this.#start - 1;
    return this.#scheduleDirectionalPrefetch() || changed;
  }

  /** Request the next physically adjacent newer batch. */
  requestLater(): boolean {
    this.#prefetchDirection = "later";
    if (this.#end >= this.#batchIds.length) {
      this.#followingTail = true;
      this.#pendingReaderAnchor = null;
      this.#prefetchDirection = "earlier";
      return false;
    }
    if (this.#candidate !== null) {
      if (this.#candidate.index === this.#end && !this.#candidate.resident) {
        this.#candidate = Object.freeze({ ...this.#candidate, reason: "navigate-later" });
        this.#queuedNavigation = null;
      } else {
        this.#queuedNavigation = "later";
      }
      return true;
    }
    return this.#schedule(this.#end, "navigate-later");
  }

  /** Admit newer geometry for native wheel/trackpad scrolling without a page jump. */
  prefetchLater(): boolean {
    if (this.#end >= this.#batchIds.length) return false;
    const changed = this.#prefetchDirection !== "later";
    this.#prefetchDirection = "later";
    if (this.#candidate !== null) return changed || this.#candidate.index === this.#end;
    return this.#scheduleDirectionalPrefetch() || changed;
  }

  /** Record whether user intent currently follows the chronological tail. */
  setFollowingTail(value: boolean): boolean {
    const direction =
      value && this.#end >= this.#batchIds.length ? "earlier" : this.#prefetchDirection;
    if (this.#followingTail === value && this.#prefetchDirection === direction) return false;
    this.#followingTail = value;
    this.#prefetchDirection = direction;
    if (value) this.#pendingReaderAnchor = null;
    if (value && this.#candidate === null && this.#end < this.#batchIds.length)
      return this.#schedule(this.#end, "prefetch-later") || true;
    return true;
  }

  /**
   * Replace reader intent with the newest measured physical window.
   *
   * @remarks Current-epoch markers remain authoritative. The controller jumps
   * directly across an unknown middle instead of serially admitting it; when
   * the newest batch itself is unknown, that batch alone becomes the next
   * measurement candidate. Any older navigation, reveal or reader-anchor work
   * is discarded before the new tail selection becomes observable.
   */
  returnToTail(): boolean {
    const previousStart = this.#start;
    const previousEnd = this.#end;
    const previousCandidate = this.#candidate;
    const previousFollowingTail = this.#followingTail;
    const previousScrollTop = this.#scrollTop;
    const tailIndex = this.#batchIds.length - 1;

    this.#pendingReaderAnchor = null;
    this.#queuedNavigation = null;
    this.#ensuredIndex = null;
    this.#followingTail = true;
    this.#prefetchDirection = "earlier";

    if (this.#geometryTransition !== null) {
      this.#returnTailAfterGeometry = true;
      return (
        previousCandidate !== this.#candidate ||
        !previousFollowingTail ||
        previousScrollTop !== this.#scrollTop
      );
    }

    if (tailIndex < 0) {
      this.#start = 0;
      this.#end = 0;
      this.#candidate = null;
      this.#scrollTop = 0;
    } else if (tailIndex >= this.#start && tailIndex < this.#end) {
      this.#candidate = null;
      this.#scrollTop = Math.max(
        0,
        this.#activeStartRow() + this.#activeRows() - this.#viewportRows,
      );
    } else {
      const tailCandidate = previousCandidate?.index === tailIndex ? previousCandidate : null;
      this.#candidate =
        tailCandidate === null
          ? null
          : tailCandidate.reason === "return-tail"
            ? tailCandidate
            : Object.freeze({ ...tailCandidate, reason: "return-tail" });
      if (this.#candidate === null) this.#schedule(tailIndex, "return-tail");
    }

    return (
      previousStart !== this.#start ||
      previousEnd !== this.#end ||
      previousCandidate !== this.#candidate ||
      !previousFollowingTail ||
      previousScrollTop !== this.#scrollTop
    );
  }

  /** Keep admitting adjacent batches until `batchId` becomes physically resident. */
  ensureBatch(batchId: string): boolean {
    const index = this.#batchIds.indexOf(batchId);
    if (index < 0) return false;
    if (index >= this.#start && index < this.#end) return true;
    this.#ensuredIndex = index;
    this.#prefetchDirection = index < this.#start ? "earlier" : "later";
    if (this.#candidate !== null) return true;
    return index < this.#start
      ? this.#schedule(this.#start - 1, "prefetch-earlier")
      : this.#schedule(this.#end, "prefetch-later");
  }

  /** Release a completed explicit reveal so ordinary runway trimming may resume. */
  releaseEnsuredBatch(batchId: string): boolean {
    const index = this.#batchIds.indexOf(batchId);
    if (index < 0 || this.#ensuredIndex !== index) return false;
    this.#ensuredIndex = null;
    return true;
  }

  /** Cancel only the transient measurement owner while retaining physical history state. */
  cancelMeasurement(): boolean {
    if (this.#candidate === null) return false;
    this.#candidate = null;
    this.#queuedNavigation = null;
    return true;
  }

  /**
   * Admit dimensions observed twice from the current OpenTUI owner.
   *
   * @returns Exact scroll adjustments: preserve the old anchor first, then
   * apply explicit user navigation if this was a boundary request.
   */
  commitMeasurement(input: {
    batchId: string;
    columns: number;
    rows: number;
    foldRevision: number;
    measurementRevision: number;
  }): TranscriptMeasurementCommit {
    const candidate = this.#candidate;
    if (
      candidate === null ||
      candidate.batchId !== input.batchId ||
      candidate.requestedMeasurementRevision !== Math.trunc(input.measurementRevision) ||
      candidate.requestedFoldRevision !== Math.max(0, Math.trunc(input.foldRevision)) ||
      positiveInteger(input.columns) !== this.#columns
    ) {
      return { accepted: false, anchorDelta: 0, navigationDelta: 0 };
    }

    const rows = positiveInteger(input.rows);
    const marker = Object.freeze({
      batchId: input.batchId,
      layoutEpoch: this.#layoutEpoch,
      columns: positiveInteger(input.columns),
      foldRevision: candidate.requestedFoldRevision,
      rows,
    });
    const geometryTransition = this.#geometryTransition;
    if (
      geometryTransition !== null &&
      candidate.reason === "remeasure" &&
      geometryTransition.batchIds.includes(candidate.batchId)
    ) {
      geometryTransition.markers.set(candidate.batchId, marker);
      this.#candidate = null;
      if (this.#scheduleGeometryMeasurement())
        return { accepted: true, anchorDelta: 0, navigationDelta: 0 };
      return this.#finishGeometryTransition();
    }

    const oldActiveStart = this.#activeStartRow();
    const oldStart = this.#start;
    const oldEnd = this.#end;
    this.#markers.set(input.batchId, marker);
    this.#lastRows.set(input.batchId, rows);

    let anchorDelta = 0;
    if (candidate.reason === "return-tail" && !candidate.resident) {
      this.#start = candidate.index;
      this.#end = candidate.index + 1;
    } else if (candidate.resident) {
      const endedBeforeViewport = candidate.top + candidate.previousRows <= this.#scrollTop;
      if (endedBeforeViewport) anchorDelta = rows - candidate.previousRows;
    } else if (oldStart === oldEnd) {
      this.#start = candidate.index;
      this.#end = candidate.index + 1;
    } else if (candidate.index === oldStart - 1) {
      this.#start = candidate.index;
      const oldOwnerStartAfterCommit = this.#activeStartRow() + rows;
      anchorDelta = oldOwnerStartAfterCommit - oldActiveStart;
    } else if (candidate.index === oldEnd) {
      this.#end = candidate.index + 1;
    } else {
      this.#candidate = null;
      return { accepted: false, anchorDelta: 0, navigationDelta: 0 };
    }

    if (this.#pendingReaderAnchor?.batchId === candidate.batchId) {
      const anchorIndex = this.#batchIds.indexOf(candidate.batchId);
      const rowOffset = Math.min(this.#pendingReaderAnchor.rowOffset, rows - 1);
      anchorDelta = this.#rowAt(anchorIndex) + rowOffset - this.#scrollTop;
      this.#pendingReaderAnchor = null;
    }

    this.#candidate = null;
    let navigationDelta =
      candidate.reason === "return-tail"
        ? Math.max(0, this.#activeStartRow() + this.#activeRows() - this.#viewportRows) -
          this.#scrollTop -
          anchorDelta
        : candidate.reason === "navigate-earlier"
          ? -this.#viewportRows
          : candidate.reason === "navigate-later"
            ? this.#viewportRows
            : 0;
    if (this.#ensuredIndex === candidate.index)
      navigationDelta = this.#rowAt(candidate.index) - this.#scrollTop - anchorDelta;
    this.#scrollTop = Math.max(0, this.#scrollTop + anchorDelta + navigationDelta);
    const queuedNavigation = this.#queuedNavigation;
    this.#queuedNavigation = null;
    if (queuedNavigation === "earlier" && this.#start > 0)
      this.#schedule(this.#start - 1, "navigate-earlier");
    if (queuedNavigation === "later" && this.#end < this.#batchIds.length)
      this.#schedule(this.#end, "navigate-later");
    if (this.#candidate === null && this.#followingTail && this.#end < this.#batchIds.length)
      this.#schedule(this.#end, "prefetch-later");
    return { accepted: true, anchorDelta, navigationDelta };
  }

  /** Current immutable physical-window projection. */
  snapshot(): TranscriptPhysicalWindow {
    const before = this.#contiguousBefore();
    const after = this.#contiguousAfter();
    return Object.freeze({
      batchIds: this.#batchIds,
      start: this.#start,
      end: this.#end,
      activeBatchIds: Object.freeze(this.#batchIds.slice(this.#start, this.#end)),
      activeRows: this.#activeRows(),
      beforeRows: before.rows,
      afterRows: after.rows,
      earlierUnknown: before.start,
      laterUnknown: this.#batchIds.length - after.end,
      candidate: this.#candidate,
      layoutEpoch: this.#layoutEpoch,
      displayColumns: this.#displayColumns,
      geometryTransition: this.#geometryTransition !== null,
      columns: this.#columns,
      viewportRows: this.#viewportRows,
      scrollTop: this.#scrollTop,
      followingTail: this.#followingTail,
      prefetchDirection: this.#prefetchDirection,
    });
  }

  /**
   * Marker currently painted by the resident owner.
   *
   * @remarks During a bounded geometry transition this remains the prior
   * presentation epoch until every replacement marker is ready to publish.
   */
  marker(batchId: string): TranscriptPhysicalMarker | undefined {
    return this.#markers.get(batchId);
  }

  /** Exact ScrollBox content row of a currently resident batch. */
  rowOf(batchId: string): number | undefined {
    const index = this.#batchIds.indexOf(batchId);
    if (index < this.#start || index >= this.#end) return undefined;
    return this.#rowAt(index);
  }

  /** Exact content row immediately after the current measured resident extent. */
  tailRow(): number {
    return this.#activeStartRow() + this.#activeRows();
  }

  #scheduleGeometryMeasurement(): boolean {
    const transition = this.#geometryTransition;
    if (transition === null || this.#candidate !== null) return false;
    for (const batchId of transition.batchIds) {
      if (transition.markers.has(batchId)) continue;
      const index = this.#batchIds.indexOf(batchId);
      if (index < this.#start || index >= this.#end) continue;
      return this.#schedule(index, "remeasure");
    }
    return false;
  }

  #finishGeometryTransition(): TranscriptMeasurementCommit {
    const transition = this.#geometryTransition;
    if (transition === null) return { accepted: false, anchorDelta: 0, navigationDelta: 0 };

    const previousScrollTop = this.#scrollTop;
    this.#markers.clear();
    for (const batchId of transition.batchIds) {
      const marker = transition.markers.get(batchId);
      if (marker === undefined || !this.#batchIds.includes(batchId)) continue;
      this.#markers.set(batchId, marker);
      this.#lastRows.set(batchId, marker.rows);
    }
    this.#displayColumns = this.#columns;
    this.#geometryTransition = null;

    let anchorDelta = 0;
    const anchor = transition.anchor;
    if (anchor !== null) {
      const index = this.#batchIds.indexOf(anchor.batchId);
      const marker = this.#markers.get(anchor.batchId);
      if (index >= this.#start && index < this.#end && marker !== undefined) {
        const requested =
          this.#rowAt(index) + Math.min(anchor.rowOffset, marker.rows - 1) - previousScrollTop;
        anchorDelta = Math.max(0, previousScrollTop + requested) - previousScrollTop;
      }
    }

    let navigationDelta = 0;
    this.#scrollTop = Math.max(0, previousScrollTop + anchorDelta);
    const returnTail = this.#returnTailAfterGeometry;
    this.#returnTailAfterGeometry = false;
    const queuedNavigation = this.#queuedNavigation;
    this.#queuedNavigation = null;
    if (returnTail) {
      const tailIndex = this.#batchIds.length - 1;
      if (tailIndex >= this.#start && tailIndex < this.#end) {
        navigationDelta =
          Math.max(0, this.#activeStartRow() + this.#activeRows() - this.#viewportRows) -
          this.#scrollTop;
        this.#scrollTop = Math.max(0, this.#scrollTop + navigationDelta);
      } else if (tailIndex >= 0) {
        this.#schedule(tailIndex, "return-tail");
      }
    } else {
      if (queuedNavigation === "earlier" && this.#start > 0)
        this.#schedule(this.#start - 1, "navigate-earlier");
      if (queuedNavigation === "later" && this.#end < this.#batchIds.length)
        this.#schedule(this.#end, "navigate-later");
      if (this.#candidate === null && this.#followingTail && this.#end < this.#batchIds.length)
        this.#schedule(this.#end, "prefetch-later");
    }
    return { accepted: true, anchorDelta, navigationDelta };
  }

  #schedule(index: number, reason: TranscriptMeasurementReason): boolean {
    if (this.#candidate !== null || index < 0 || index >= this.#batchIds.length) return false;
    const batchId = this.#batchIds[index];
    if (batchId === undefined) return false;
    const resident = index >= this.#start && index < this.#end;
    const previousRows = this.#markers.get(batchId)?.rows ?? this.#lastRows.get(batchId) ?? 0;
    const requestedFoldRevision = this.#foldRevisions.get(batchId) ?? 0;
    this.#candidate = Object.freeze({
      batchId,
      index,
      reason,
      resident,
      top: resident ? this.#rowAt(index) : this.#scrollTop,
      requestedFoldRevision,
      requestedMeasurementRevision:
        this.#layoutEpoch * TRANSCRIPT_LAYOUT_EPOCH_STRIDE + requestedFoldRevision,
      previousRows,
    });
    return true;
  }

  #missingResidentIndex(): number | null {
    for (let index = this.#end - 1; index >= this.#start; index -= 1) {
      const id = this.#batchIds[index];
      if (id !== undefined && !this.#markers.has(id)) return index;
    }
    return null;
  }

  #readerAnchor(): ReaderAnchor | null {
    let row = this.#activeStartRow();
    for (let index = this.#start; index < this.#end; index += 1) {
      const batchId = this.#batchIds[index];
      const rows = batchId === undefined ? undefined : this.#markers.get(batchId)?.rows;
      if (batchId === undefined || rows === undefined) return null;
      if (this.#scrollTop < row + rows) {
        return Object.freeze({
          batchId,
          rowOffset: Math.max(0, this.#scrollTop - row),
        });
      }
      row += rows;
    }
    return null;
  }

  #activeRows(): number {
    let rows = 0;
    for (let index = this.#start; index < this.#end; index += 1) {
      const id = this.#batchIds[index];
      if (id !== undefined) rows += this.#markers.get(id)?.rows ?? 0;
    }
    return rows;
  }

  #contiguousBefore(): { start: number; rows: number } {
    let start = this.#start;
    let rows = 0;
    while (start > 0) {
      const id = this.#batchIds[start - 1];
      const marker = id === undefined ? undefined : this.#markers.get(id);
      if (marker === undefined) break;
      start -= 1;
      rows += marker.rows;
    }
    return { start, rows };
  }

  #contiguousAfter(): { end: number; rows: number } {
    let end = this.#end;
    let rows = 0;
    while (end < this.#batchIds.length) {
      const id = this.#batchIds[end];
      const marker = id === undefined ? undefined : this.#markers.get(id);
      if (marker === undefined) break;
      rows += marker.rows;
      end += 1;
    }
    return { end, rows };
  }

  #activeStartRow(): number {
    const before = this.#contiguousBefore();
    return (before.start > 0 ? 1 : 0) + before.rows;
  }

  #rowAt(index: number): number {
    let row = this.#activeStartRow();
    for (let cursor = this.#start; cursor < index; cursor += 1) {
      const id = this.#batchIds[cursor];
      if (id !== undefined) row += this.#markers.get(id)?.rows ?? 0;
    }
    return row;
  }

  #scheduleDirectionalPrefetch(): boolean {
    if (this.#candidate !== null || this.#start >= this.#end) return false;
    if (this.#followingTail && this.#end < this.#batchIds.length)
      return this.#schedule(this.#end, "prefetch-later");

    const activeStart = this.#activeStartRow();
    const activeEnd = activeStart + this.#activeRows();
    const viewportEnd = this.#scrollTop + this.#viewportRows;
    const aheadRows = this.#viewportRows * TRANSCRIPT_PREFETCH_AHEAD_VIEWPORTS;
    const behindRows = this.#viewportRows * TRANSCRIPT_RETAIN_BEHIND_VIEWPORTS;
    if (this.#prefetchDirection === "earlier") {
      if (this.#scrollTop < activeStart + aheadRows && this.#start > 0)
        return this.#schedule(this.#start - 1, "prefetch-earlier");
      if (viewportEnd > activeEnd - behindRows && this.#end < this.#batchIds.length)
        return this.#schedule(this.#end, "prefetch-later");
      return false;
    }
    if (viewportEnd > activeEnd - aheadRows && this.#end < this.#batchIds.length)
      return this.#schedule(this.#end, "prefetch-later");
    if (this.#scrollTop < activeStart + behindRows && this.#start > 0)
      return this.#schedule(this.#start - 1, "prefetch-earlier");
    return false;
  }

  #trimOutsideRunway(): boolean {
    if (this.#start >= this.#end || this.#ensuredIndex !== null) return false;
    const beforeViewports =
      this.#prefetchDirection === "earlier"
        ? TRANSCRIPT_PREFETCH_AHEAD_VIEWPORTS
        : TRANSCRIPT_RETAIN_BEHIND_VIEWPORTS;
    const afterViewports =
      this.#prefetchDirection === "later"
        ? TRANSCRIPT_PREFETCH_AHEAD_VIEWPORTS
        : TRANSCRIPT_RETAIN_BEHIND_VIEWPORTS;
    const keepStart = Math.max(0, this.#scrollTop - this.#viewportRows * beforeViewports);
    const keepEnd = this.#scrollTop + this.#viewportRows + this.#viewportRows * afterViewports;
    let nextStart = this.#start;
    let cursor = this.#activeStartRow();
    while (nextStart + 1 < this.#end) {
      const id = this.#batchIds[nextStart];
      const rows = id === undefined ? 0 : (this.#markers.get(id)?.rows ?? 0);
      if (cursor + rows > keepStart) break;
      cursor += rows;
      nextStart += 1;
    }

    let nextEnd = this.#end;
    let endCursor = this.#activeStartRow() + this.#activeRows();
    while (nextEnd - 1 > nextStart) {
      const id = this.#batchIds[nextEnd - 1];
      const rows = id === undefined ? 0 : (this.#markers.get(id)?.rows ?? 0);
      if (endCursor - rows < keepEnd) break;
      endCursor -= rows;
      nextEnd -= 1;
    }

    if (nextStart === this.#start && nextEnd === this.#end) return false;
    this.#start = nextStart;
    this.#end = nextEnd;
    return true;
  }
}

/** Construct a fresh physical marker ledger for one committed-history surface. */
export function createPhysicalWindowController(): PhysicalTranscriptWindowController {
  return new PhysicalTranscriptWindowController();
}
