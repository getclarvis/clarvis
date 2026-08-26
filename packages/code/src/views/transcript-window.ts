import { rawToolArguments, type TranscriptNode } from "../adapters/store.ts";
import {
  transcriptDisplayTextChars,
  TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS,
} from "../core/transcript/presenters.ts";
import { transcriptToolMountedTextChars } from "../core/transcript/tool-display.ts";

/**
 * The four bounds on one mounted transcript page.
 *
 * @remarks They exist because a page is expensive in more than one currency and
 * no single number bounds all of them. Blocks are what the *user* counts;
 * renderables are what OpenTUI mounts, and one block is not one renderable — a
 * long assistant message becomes several; and characters are what the terminal
 * ultimately has to lay out, which a page of few but enormous blocks can exhaust
 * while both counts look small. Each budget catches a page shape the others
 * miss, which is why removing any of them removes a real case rather than
 * simplifying the pager.
 *
 * They are not peers. {@link WINDOW_MIN_BLOCKS} is not a page size but the point
 * before which the pager may not stop at a turn boundary — without it a page
 * would end after three blocks merely because a turn happened to start there.
 * The other three are ceilings, and whichever binds first ends the page, which
 * is what makes them independent rather than redundant.
 *
 * One node is always admitted whatever it costs, so a single block larger than
 * every budget still renders instead of producing an empty page.
 */

/** Minimum useful page size when the render budget permits it. */
export const WINDOW_MIN_BLOCKS = 80;

/** Absolute semantic-node ceiling for one mounted transcript page. */
export const WINDOW_MAX_BLOCKS = 400;

/** Estimated native-renderable budget for one mounted transcript page. */
export const WINDOW_RENDER_BUDGET = 900;

/**
 * Hard ceiling for semantic text handed to OpenTUI by one mounted page.
 *
 * @remarks Not a number of its own: it *is*
 * {@link TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS}, the same ceiling a single node's
 * display text is clamped to. Sharing it is what guarantees one maximal node
 * always fits in a page, so the floor above can never be defeated by a block the
 * budget cannot admit.
 */
export const WINDOW_TEXT_CHARS_BUDGET = TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS;

/** Smallest stable Markdown prefix; used as a conservative native-node estimate. */
const ASSISTANT_RENDER_CHUNK_CHARS = 4096;

const TURN_PREFIX = "user:";

/** Range counter used by the transcript pager for its history labels. */
export interface TranscriptTurnCounter {
  /** Count turn boundaries in the half-open source range. */
  count(nodes: readonly TranscriptNode[], start: number, end: number): number;
}

/**
 * Build an append-aware turn-boundary index for a long-lived transcript.
 *
 * The transcript store keeps one array identity while streamed nodes append.
 * Remembering only turn positions makes an ordinary append O(appended nodes)
 * while range counts stay O(log turns). A replacement, truncation or changed
 * former tail rebuilds the index so session switches and reconciliation remain
 * correct.
 */
export function createTranscriptTurnIndex(): TranscriptTurnCounter {
  let source: readonly TranscriptNode[] | undefined;
  let scannedLength = 0;
  let scannedTailKey: string | undefined;
  let turnPositions: number[] = [];

  const lowerBound = (target: number): number => {
    let low = 0;
    let high = turnPositions.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (turnPositions[middle]! < target) low = middle + 1;
      else high = middle;
    }
    return low;
  };

  const rebuild = (nodes: readonly TranscriptNode[]): void => {
    turnPositions = [];
    for (let index = 0; index < nodes.length; index += 1) {
      if (nodes[index]!.key.startsWith(TURN_PREFIX)) turnPositions.push(index);
    }
    source = nodes;
    scannedLength = nodes.length;
    scannedTailKey = nodes.at(-1)?.key;
  };

  const extend = (nodes: readonly TranscriptNode[]): void => {
    for (let index = scannedLength; index < nodes.length; index += 1) {
      if (nodes[index]!.key.startsWith(TURN_PREFIX)) turnPositions.push(index);
    }
    scannedLength = nodes.length;
    scannedTailKey = nodes.at(-1)?.key;
  };

  return {
    count(nodes, start, end) {
      const formerTailStillMatches =
        scannedLength === 0 || nodes[scannedLength - 1]?.key === scannedTailKey;
      if (source !== nodes || nodes.length < scannedLength || !formerTailStillMatches) {
        rebuild(nodes);
      } else if (nodes.length > scannedLength) {
        extend(nodes);
      }
      return lowerBound(end) - lowerBound(start);
    },
  };
}

/** A filtered sub-agent transcript contains no `user:` turn boundaries. */
export const NO_TRANSCRIPT_TURNS: TranscriptTurnCounter = {
  count: () => 0,
};

/**
 * Conservative render cost for a semantic node.
 *
 * The values include the node's boxes, labels and common conditional children.
 * Every semantic text field pays by its presented character count; assistant
 * Markdown additionally expands into stable segments. The estimate deliberately
 * errs high for tools because they are the shape that previously made one turn
 * mount thousands of native objects.
 */
export function transcriptNodeRenderCost(node: TranscriptNode): number {
  const textCost = Math.ceil(transcriptNodeMountedTextChars(node) / ASSISTANT_RENDER_CHUNK_CHARS);
  switch (node.kind) {
    case "tool_call":
      return 12 + textCost;
    case "assistant":
      return 8 + textCost;
    case "subagent":
    case "plan":
    case "error":
      return 6 + textCost;
    case "user":
    case "reasoning":
    case "run":
      return 5 + textCost;
    default:
      return 3 + textCost;
  }
}

/** Semantic text characters the presenter will actually mount for one node. */
export function transcriptNodeMountedTextChars(node: TranscriptNode): number {
  return node.kind === "tool_call"
    ? transcriptToolMountedTextChars(node, rawToolArguments(node))
    : transcriptDisplayTextChars(node);
}

/** One bounded page and the history on either side of it. */
export interface TranscriptWindow {
  readonly nodes: readonly TranscriptNode[];
  readonly hiddenTurns: number;
  readonly hiddenBlocks: number;
  readonly laterTurns: number;
  readonly laterBlocks: number;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  readonly start: number;
  readonly end: number;
  readonly renderCost: number;
  readonly mountedTextChars: number;
}

function selectTranscriptWindow(
  nodes: readonly TranscriptNode[],
  pageEnd: number | null,
  turnCounter: TranscriptTurnCounter,
  minBlocks: number,
  maxBlocks: number,
  renderBudget: number,
): TranscriptWindow {
  const end = pageEnd === null ? nodes.length : Math.max(0, Math.min(nodes.length, pageEnd));
  const min = Math.max(1, Math.floor(minBlocks));
  const max = Math.max(min, Math.floor(maxBlocks));
  const budget = Math.max(1, Math.floor(renderBudget));
  const textBudget = WINDOW_TEXT_CHARS_BUDGET;
  let start = end;
  let renderCost = 0;
  let mountedTextChars = 0;

  while (start > 0) {
    const node = nodes[start - 1]!;
    const cost = transcriptNodeRenderCost(node);
    const textChars = transcriptNodeMountedTextChars(node);
    if (
      end - start >= max ||
      (start < end && (renderCost + cost > budget || mountedTextChars + textChars > textBudget))
    )
      break;
    start -= 1;
    renderCost += cost;
    mountedTextChars += textChars;
    if (end - start >= min && node.key.startsWith(TURN_PREFIX)) break;
  }

  const shown = start === 0 && end === nodes.length ? nodes : nodes.slice(start, end);
  return {
    nodes: shown,
    hiddenTurns: turnCounter.count(nodes, 0, start),
    hiddenBlocks: start,
    laterTurns: turnCounter.count(nodes, end, nodes.length),
    laterBlocks: nodes.length - end,
    atStart: start === 0,
    atEnd: end === nodes.length,
    start,
    end,
    renderCost,
    mountedTextChars,
  };
}

/**
 * Select a page using a caller-owned append-aware turn index.
 *
 * This is the production path: page selection remains proportional to the
 * mounted window, and hidden/later labels no longer rescan the whole session on
 * every streamed structural append.
 */
export function windowTranscriptIndexed(
  nodes: readonly TranscriptNode[],
  pageEnd: number | null,
  turnCounter: TranscriptTurnCounter,
  minBlocks: number = WINDOW_MIN_BLOCKS,
  maxBlocks: number = WINDOW_MAX_BLOCKS,
  renderBudget: number = WINDOW_RENDER_BUDGET,
): TranscriptWindow {
  return selectTranscriptWindow(nodes, pageEnd, turnCounter, minBlocks, maxBlocks, renderBudget);
}

/** Label for the page of older history. */
export function earlierLabel(window: TranscriptWindow): string {
  if (window.hiddenTurns > 0)
    return `${window.hiddenTurns} earlier turn${window.hiddenTurns === 1 ? "" : "s"}`;
  return `${window.hiddenBlocks} earlier block${window.hiddenBlocks === 1 ? "" : "s"}`;
}

/** Label for history newer than the page currently mounted. */
export function laterLabel(window: TranscriptWindow): string {
  if (window.laterTurns > 0)
    return `${window.laterTurns} later turn${window.laterTurns === 1 ? "" : "s"}`;
  return `${window.laterBlocks} later block${window.laterBlocks === 1 ? "" : "s"}`;
}
