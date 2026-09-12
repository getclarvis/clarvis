import type { TranscriptRowId } from "./identity.ts";

const TRANSCRIPT_FULL_MOUNT_CEILING = 80;
const TRANSCRIPT_WINDOW_ROWS = 40;
const TRANSCRIPT_PAGE_ROWS = 20;
export const EXPLORATION_PAGE_MEMBERS = 20;

/** Reader intent uses a row's position relative to the viewport, never a session-global pixel. */
export type ReaderPosition =
  { mode: "tail" } | { mode: "anchor"; rowId: TranscriptRowId; screenY: number };

/** Pure bounded resident interval; native layout remains the viewport adapter's responsibility. */
export class TranscriptWindow {
  ids: readonly TranscriptRowId[] = [];
  start = 0;
  end = 0;
  reader: ReaderPosition = { mode: "tail" };

  sync(ids: readonly TranscriptRowId[]): void {
    const first = this.ids[this.start];
    this.ids = ids;
    if (this.reader.mode === "tail") {
      this.tail();
      return;
    }
    const anchor = ids.indexOf(this.reader.rowId);
    const priorStart = first === undefined ? -1 : ids.indexOf(first);
    this.start = Math.max(0, priorStart >= 0 ? priorStart : anchor >= 0 ? anchor : this.start);
    const size = this.size();
    if (anchor >= 0 && anchor >= this.start + size) this.start = anchor - size + 1;
    this.start = Math.min(this.start, Math.max(0, ids.length - size));
    this.end = Math.min(ids.length, this.start + size);
  }

  size(): number {
    return this.ids.length <= TRANSCRIPT_FULL_MOUNT_CEILING
      ? this.ids.length
      : TRANSCRIPT_WINDOW_ROWS;
  }
  tail(): void {
    this.reader = { mode: "tail" };
    this.end = this.ids.length;
    this.start = Math.max(0, this.end - this.size());
  }
  page(direction: -1 | 1): boolean {
    const previousStart = this.start;
    const previousEnd = this.end;
    const start = Math.max(
      0,
      Math.min(
        Math.max(0, this.ids.length - this.size()),
        this.start + direction * TRANSCRIPT_PAGE_ROWS,
      ),
    );
    if (start === this.start) return false;
    const anchor = this.reader.mode === "anchor" ? this.ids.indexOf(this.reader.rowId) : -1;
    this.start = anchor >= 0 ? Math.min(start, anchor) : start;
    this.end = Math.min(this.ids.length, Math.max(start + this.size(), anchor + 1));
    return this.start !== previousStart || this.end !== previousEnd;
  }
  reveal(id: TranscriptRowId): boolean {
    const index = this.ids.indexOf(id);
    if (index < 0) return false;
    if (index < this.start || index >= this.end) {
      this.start = Math.max(
        0,
        Math.min(index - Math.floor(this.size() / 2), this.ids.length - this.size()),
      );
      this.end = Math.min(this.ids.length, this.start + this.size());
    }
    this.reader = { mode: "anchor", rowId: id, screenY: 0 };
    return true;
  }
  resident(): readonly TranscriptRowId[] {
    return this.ids.slice(this.start, this.end);
  }
}
