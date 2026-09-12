/** Sessions at or below this committed-batch count mount every owner. */
export const TRANSCRIPT_FULL_MOUNT_CEILING = 80;

/** Sliding window size once the full-mount ceiling is exceeded. */
export const TRANSCRIPT_MOUNTED_BATCH_COUNT = 40;

/** Batches admitted by one revealOlder/revealNewer call. */
const TRANSCRIPT_REVEAL_BATCH_COUNT = 20;

/** Hint rows for hidden older or newer history. Never a measured sum. */
export const TRANSCRIPT_HIDDEN_HINT_ROWS = 1;

/** Immutable projection consumed by the Solid ScrollBox owner. */
export interface TranscriptVisibleSlice {
  readonly batchIds: readonly string[];
  readonly start: number;
  readonly end: number;
  readonly activeBatchIds: readonly string[];
  readonly earlierUnknown: number;
  readonly laterUnknown: number;
  readonly beforeRows: number;
  readonly afterRows: number;
  readonly followingTail: boolean;
  readonly navigating: boolean;
  readonly viewportRows: number;
  readonly scrollTop: number;
  readonly columns: number;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Owns a bounded index window over immutable transcript batches.
 *
 * @remarks Geometry never crosses this boundary. OpenTUI's native ScrollBox
 * follows the tail; this class only decides which frozen owners stay mounted.
 */
export class TranscriptVisibleSliceController {
  #batchIds: readonly string[] = Object.freeze([]);
  #start = 0;
  #end = 0;
  #followingTail = true;
  #navigating = false;
  #viewportRows = 1;
  #scrollTop = 0;
  #columns = 1;

  /** Current index window and follow/navigation flags. */
  snapshot(): TranscriptVisibleSlice {
    const earlierUnknown = this.#start;
    const laterUnknown = Math.max(0, this.#batchIds.length - this.#end);
    return Object.freeze({
      batchIds: this.#batchIds,
      start: this.#start,
      end: this.#end,
      activeBatchIds: Object.freeze(this.#batchIds.slice(this.#start, this.#end)),
      earlierUnknown,
      laterUnknown,
      beforeRows: earlierUnknown > 0 ? TRANSCRIPT_HIDDEN_HINT_ROWS : 0,
      afterRows: laterUnknown > 0 ? TRANSCRIPT_HIDDEN_HINT_ROWS : 0,
      followingTail: this.#followingTail,
      navigating: this.#navigating,
      viewportRows: this.#viewportRows,
      scrollTop: this.#scrollTop,
      columns: this.#columns,
    });
  }

  /**
   * Reconcile the published batch identity list and optional viewport metrics.
   *
   * @returns true when the visible slice or follow flags changed.
   */
  sync(input: {
    readonly batchIds: readonly string[];
    readonly columns?: number;
    readonly viewportRows?: number;
    readonly scrollTop?: number;
  }): boolean {
    const nextIds = Object.freeze([...input.batchIds]);
    const columns = clampInteger(input.columns ?? this.#columns, 1, Number.MAX_SAFE_INTEGER);
    const viewportRows = clampInteger(
      input.viewportRows ?? this.#viewportRows,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const scrollTop = clampInteger(input.scrollTop ?? this.#scrollTop, 0, Number.MAX_SAFE_INTEGER);
    const previous = this.snapshot();
    this.#batchIds = nextIds;
    this.#columns = columns;
    this.#viewportRows = viewportRows;
    this.#scrollTop = scrollTop;
    if (this.#followingTail || nextIds.length <= TRANSCRIPT_FULL_MOUNT_CEILING) this.#fitToTail();
    else this.#clampWindow();
    return !this.#sameSlice(previous);
  }

  /** Record native scroll metrics without changing which owners are mounted. */
  observe(input: {
    readonly scrollTop: number;
    readonly viewportRows: number;
    readonly atBottom: boolean;
  }): boolean {
    const previous = this.snapshot();
    this.#scrollTop = clampInteger(input.scrollTop, 0, Number.MAX_SAFE_INTEGER);
    this.#viewportRows = clampInteger(input.viewportRows, 1, Number.MAX_SAFE_INTEGER);
    if (input.atBottom) {
      this.#followingTail = true;
      this.#navigating = false;
      this.#fitToTail();
    } else if (this.#followingTail || this.#navigating) {
      this.#followingTail = false;
    }
    return !this.#sameSlice(previous);
  }

  /** Slide the window toward older batches. */
  revealOlder(count: number = TRANSCRIPT_REVEAL_BATCH_COUNT): boolean {
    if (this.#start === 0) return false;
    const previous = this.snapshot();
    this.#followingTail = false;
    const size = this.#windowSize(this.#batchIds.length);
    const nextStart = Math.max(0, this.#start - Math.max(1, Math.trunc(count)));
    this.#start = nextStart;
    this.#end = Math.min(this.#batchIds.length, nextStart + size);
    return !this.#sameSlice(previous);
  }

  /** Slide the window toward newer batches. */
  revealNewer(count: number = TRANSCRIPT_REVEAL_BATCH_COUNT): boolean {
    if (this.#end >= this.#batchIds.length) return false;
    const previous = this.snapshot();
    const size = this.#windowSize(this.#batchIds.length);
    const nextEnd = Math.min(this.#batchIds.length, this.#end + Math.max(1, Math.trunc(count)));
    this.#end = nextEnd;
    this.#start = Math.max(0, nextEnd - size);
    if (this.#end >= this.#batchIds.length) {
      this.#followingTail = true;
      this.#navigating = false;
    } else this.#followingTail = false;
    return !this.#sameSlice(previous);
  }

  /** Include one batch in the mounted window and pause native stick until the tail. */
  ensureBatch(batchId: string): boolean {
    const index = this.#batchIds.indexOf(batchId);
    if (index < 0) return false;
    const previous = this.snapshot();
    const size = this.#windowSize(this.#batchIds.length);
    if (size >= this.#batchIds.length) {
      this.#start = 0;
      this.#end = this.#batchIds.length;
    } else {
      const idealStart = Math.min(
        Math.max(0, index - Math.floor(size / 2)),
        this.#batchIds.length - size,
      );
      this.#start = idealStart;
      this.#end = idealStart + size;
    }
    const atTail = this.#end >= this.#batchIds.length && index >= this.#start;
    this.#followingTail = atTail;
    this.#navigating = !atTail;
    return !this.#sameSlice(previous);
  }

  /** Mount the newest window and resume native stick. */
  returnToTail(): boolean {
    const previous = this.snapshot();
    this.#followingTail = true;
    this.#navigating = false;
    this.#fitToTail();
    return !this.#sameSlice(previous);
  }

  /** Pause tail following after explicit upward movement without cancelling key navigation. */
  pauseFollowing(): boolean {
    if (!this.#followingTail) return false;
    this.#followingTail = false;
    return true;
  }

  #windowSize(count: number): number {
    if (count <= TRANSCRIPT_FULL_MOUNT_CEILING) return count;
    return Math.min(TRANSCRIPT_MOUNTED_BATCH_COUNT, count);
  }

  #fitToTail(): void {
    const size = this.#windowSize(this.#batchIds.length);
    this.#end = this.#batchIds.length;
    this.#start = Math.max(0, this.#end - size);
  }

  #clampWindow(): void {
    const size = this.#windowSize(this.#batchIds.length);
    if (size >= this.#batchIds.length) {
      this.#start = 0;
      this.#end = this.#batchIds.length;
      return;
    }
    this.#start = clampInteger(this.#start, 0, this.#batchIds.length - size);
    this.#end = this.#start + size;
  }

  #sameSlice(previous: TranscriptVisibleSlice): boolean {
    const next = this.snapshot();
    return (
      sameIds(previous.batchIds, next.batchIds) &&
      previous.start === next.start &&
      previous.end === next.end &&
      previous.followingTail === next.followingTail &&
      previous.navigating === next.navigating &&
      previous.viewportRows === next.viewportRows &&
      previous.scrollTop === next.scrollTop &&
      previous.columns === next.columns
    );
  }
}

/** Construct a fresh index window for one committed-history surface. */
export function createVisibleSliceController(): TranscriptVisibleSliceController {
  return new TranscriptVisibleSliceController();
}
