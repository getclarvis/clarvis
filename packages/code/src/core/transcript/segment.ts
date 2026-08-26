/**
 * How many characters a segment must reach before a cut is considered.
 *
 * @remarks Deliberately large. Below it a message is one segment and renders
 *   exactly as it always has, which is the case for the overwhelming majority
 *   of replies; the segmentation only exists for the long ones, where re-parsing
 *   an ever-growing trailing token on every delta is what costs a frame.
 */
export const SEGMENT_MIN = 4096;

/**
 * Above this many characters, an unsealed tail stops being parsed as Markdown
 * while its node is still streaming.
 *
 * @remarks Reached only when no legal cut exists — a fenced block that has run
 *   past 24 KB without closing, so every blank line inside it is off-limits.
 *   There is no cheaper parse available at that point, only no parse: a plain
 *   text render of the same content measures ~0.5 ms against ~50 ms, and 50 ms
 *   is one and a half frames. The content returns to Markdown, syntax
 *   highlighting included, the moment the node settles.
 */
export const TAIL_PLAIN_CAP = 24_576;

/** A settled reply larger than this stays plain instead of starting a large highlight job. */
export const FINAL_MARKDOWN_CAP = 65_536;

/** Maximum number of highlighted prefixes retained for one streamed reply. */
export const MAX_MARKDOWN_SEGMENTS = 64;

/** Size of stable plain chunks emitted after Markdown segmentation is deliberately abandoned. */
const PLAIN_SEGMENT_SIZE = 16_384;

/** A Markdown document split into stable sealed prefixes plus its unstable tail. */
export interface MarkdownSegments {
  /**
   * The sealed prefixes, in order.
   *
   * @remarks Invariant: `sealed.join("") + tail` is the input, exactly.
   */
  sealed: string[];
  /** Everything after the last cut — the part still growing while a run streams. */
  tail: string;
}

/** One prefix whose identity and owned text remain stable across later appends. */
export interface StableMarkdownSegment {
  readonly id: number;
  readonly kind: "markdown" | "plain";
  readonly text: string;
}

/** Incremental projection consumed by the assistant renderer. */
export interface IncrementalMarkdownSegments {
  readonly sealed: readonly StableMarkdownSegment[];
  readonly tail: string;
  /** Plain only after the bounded simplification fallback; ordinary tails stay Markdown. */
  readonly tailKind: "markdown" | "plain";
  /** Whether final formatting was intentionally simplified to stay bounded. */
  readonly simplified: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Copy a sealed prefix into its own backing store.
 *
 * Substrings can retain the complete cumulative provider response in JavaScript
 * engines. Encoding once at the seal boundary makes the prefix independent of
 * the ever-growing source string and lets the previous aggregate be collected.
 */
function ownString(value: string): string {
  return decoder.decode(encoder.encode(value));
}

/** Whether `line` opens or closes a fenced code block. */
function isFence(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("```") || t.startsWith("~~~");
}

/** Whether `line` is indented enough to be an indented code block's content. */
function isIndentedCode(line: string): boolean {
  return line.startsWith("    ") || line.startsWith("\t");
}

/**
 * Whether the first non-blank line at or after `from` is indented code.
 *
 * @remarks A blank line between two indented lines is *interior* to an indented
 *   code block, not a paragraph break: cutting there turns one code block into
 *   two, complete with the inter-block margin between them. Looking ahead is the
 *   only way to tell the two apart, since the blank line itself is identical.
 */
function continuesIndentedCode(text: string, from: number): boolean {
  let cursor = from;
  while (cursor < text.length) {
    const br = text.indexOf("\n", cursor);
    const stop = br === -1 ? text.length : br;
    const line = text.slice(cursor, stop);
    if (line.trim().length > 0) return isIndentedCode(line);
    if (br === -1) return false;
    cursor = br + 1;
  }
  return false;
}

/**
 * Split `text` into sealed segments plus the trailing, still-unstable remainder.
 *
 * A cut is taken only on a blank line that is **outside** a fenced code block,
 * and only once the segment being accumulated has reached `min` characters.
 *
 * @param text - the Markdown source to split.
 * @param min - characters a segment must reach before a cut is considered;
 *   defaults to {@link SEGMENT_MIN}.
 * @returns the {@link MarkdownSegments} split of `text`.
 * @remarks **Prefix-stable**, and that is the whole point: every cut depends
 *   only on the characters before it, so appending to `text` never moves a cut
 *   already taken. That is what lets a renderer keep the sealed segments mounted
 *   and re-parse only the tail, turning a cost quadratic in message length into
 *   a constant one.
 *
 *   Fence tracking is a toggle over lines whose first non-space characters are
 *   ` ``` ` or `~~~`, which is why a cut can never land inside a code block: an
 *   unterminated fence simply means no further cut is available, and the whole
 *   remainder stays in `tail`.
 */
export function segmentMarkdown(text: string, min: number = SEGMENT_MIN): MarkdownSegments {
  if (text.length <= min) return { sealed: [], tail: text };

  const sealed: string[] = [];
  let fence = false;
  let start = 0;
  let cursor = 0;

  let lastCode = false;
  while (cursor < text.length) {
    const br = text.indexOf("\n", cursor);
    const end = br === -1 ? text.length : br + 1;
    const line = text.slice(cursor, br === -1 ? text.length : br);
    const blank = line.trim().length === 0;
    if (isFence(line)) fence = !fence;
    else if (
      !fence &&
      blank &&
      /**
       * Only a *terminated* blank line may be cut on. The last line of a
       * still-streaming message has no newline yet, and a whitespace-only one
       * would otherwise take a cut that the very next delta withdraws when the
       * line turns out to have content — breaking the prefix stability this
       * function promises, and remounting the whole message to boot.
       */
      br !== -1 &&
      end - start >= min &&
      !(lastCode && continuesIndentedCode(text, end))
    ) {
      sealed.push(text.slice(start, end));
      start = end;
    }
    if (!blank) lastCode = isIndentedCode(line) && !fence;
    cursor = end;
  }

  return { sealed, tail: text.slice(start) };
}

/**
 * Stateful, append-only Markdown segmentation for a single transcript node.
 *
 * Only the unsealed tail plus the new suffix is scanned. `epoch` is the source
 * of truth for retry/final-response resets, so this object never retains an old
 * cumulative response merely to compare prefixes. During a run the mutable
 * tail stays Markdown unless a bounded simplification fallback becomes
 * necessary. Ordinary settlement preserves every sealed prefix; only a
 * simplification boundary or source reset rebuilds the document.
 */
export class IncrementalMarkdownSegmenter {
  readonly #min: number;
  #epoch = -1;
  #length = 0;
  #running = true;
  #tail = "";
  #sealed: StableMarkdownSegment[] = [];
  #nextId = 1;
  #forcedPlain = false;
  #markdownSegments = 0;
  #simplified = false;

  constructor(min: number = SEGMENT_MIN) {
    this.#min = Math.max(1, Math.floor(min));
  }

  update(text: string, epoch: number, running: boolean): IncrementalMarkdownSegments {
    if (epoch !== this.#epoch || text.length < this.#length || (!this.#running && running)) {
      this.#rebuild(text, epoch, running);
    } else if (this.#running && !running) {
      this.#settle(text, epoch);
    } else if (text.length > this.#length) {
      this.#append(text.slice(this.#length));
      this.#length = text.length;
    }
    return this.#snapshot();
  }

  reset(): void {
    this.#epoch = -1;
    this.#length = 0;
    this.#running = true;
    this.#tail = "";
    this.#sealed = [];
    this.#nextId = 1;
    this.#forcedPlain = false;
    this.#markdownSegments = 0;
    this.#simplified = false;
  }

  #snapshot(): IncrementalMarkdownSegments {
    return {
      // `#seal` publishes a fresh array only when the mounted segment list
      // changes. Cloning it on every provider delta made a long plain response
      // copy thousands of segment references for each small tail update.
      sealed: this.#sealed,
      tail: this.#tail,
      tailKind: this.#forcedPlain ? "plain" : "markdown",
      simplified: this.#simplified,
    };
  }

  #rebuild(text: string, epoch: number, running: boolean): void {
    this.#epoch = epoch;
    this.#length = text.length;
    this.#running = running;
    this.#tail = "";
    this.#sealed = [];
    this.#forcedPlain = false;
    this.#markdownSegments = 0;
    this.#simplified = false;

    if (running) {
      this.#append(text);
      return;
    }

    if (text.length > FINAL_MARKDOWN_CAP) {
      this.#simplified = true;
      this.#appendPlainDocument(text);
      return;
    }

    const segmented = segmentMarkdown(text, this.#min);
    for (const part of segmented.sealed) this.#seal("markdown", part);
    this.#tail = segmented.tail;
  }

  #settle(text: string, epoch: number): void {
    if (text.length > FINAL_MARKDOWN_CAP || this.#forcedPlain) {
      this.#rebuild(text, epoch, false);
      return;
    }
    if (text.length > this.#length) this.#append(text.slice(this.#length));
    this.#length = text.length;
    this.#running = false;
  }

  #append(suffix: string): void {
    if (suffix.length === 0) return;
    const work = this.#tail + suffix;
    if (this.#forcedPlain) {
      this.#tail = work;
      this.#sealPlainOverflow();
      return;
    }

    const segmented = segmentMarkdown(work, this.#min);
    for (let index = 0; index < segmented.sealed.length; index += 1) {
      if (this.#markdownSegments >= MAX_MARKDOWN_SEGMENTS) {
        this.#forcedPlain = true;
        this.#simplified = true;
        this.#tail = segmented.sealed.slice(index).join("") + segmented.tail;
        this.#sealPlainOverflow();
        return;
      }
      this.#seal("markdown", segmented.sealed[index]!);
    }
    this.#tail = segmented.tail;
    if (this.#tail.length > TAIL_PLAIN_CAP) {
      this.#forcedPlain = true;
      this.#simplified = true;
      this.#sealPlainOverflow();
    }
  }

  #appendPlainDocument(text: string): void {
    for (let start = 0; start < text.length; start += PLAIN_SEGMENT_SIZE)
      this.#seal("plain", text.slice(start, start + PLAIN_SEGMENT_SIZE));
  }

  #sealPlainOverflow(): void {
    while (this.#tail.length > PLAIN_SEGMENT_SIZE) {
      this.#seal("plain", this.#tail.slice(0, PLAIN_SEGMENT_SIZE));
      this.#tail = this.#tail.slice(PLAIN_SEGMENT_SIZE);
    }
  }

  #seal(kind: StableMarkdownSegment["kind"], text: string): void {
    this.#sealed = [...this.#sealed, { id: this.#nextId++, kind, text: ownString(text) }];
    if (kind === "markdown") this.#markdownSegments += 1;
  }
}
