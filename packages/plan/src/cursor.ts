/**
 * The self-identifying envelope every plan paging cursor travels in.
 *
 * A cursor stays **opaque** to its holder — the same string a page returns is
 * the string the next page is asked for — but it is no longer anonymous. Each
 * backend pages in a dialect of its own: the file adapter's payload is a
 * filename used as an exclusive descending lexical bound, the process-local
 * adapter's is a record id, and a provider's is whatever the remote mints. Fed
 * to the wrong backend, all three used to decode as *something* and silently
 * return the first page again, so a client paging across a backend change, or a
 * model repeating a stale cursor, looped instead of being told.
 *
 * Tagging makes that a named {@link PlanCursorError} at the boundary. It does
 * not make a cursor portable, and deliberately says nothing about whether the
 * position a correctly-tagged cursor names still exists — an adapter that
 * tolerates a vanished target keeps tolerating it.
 */

/**
 * The paging dialect each cursor producer stamps its cursors with.
 *
 * @remarks The values are short, stable and version-suffixed: a backend that
 * changes what its payload means mints a new tag rather than reinterpreting the
 * old one, so the stale cursors already in a client's paging stack fail loudly
 * instead of resolving to a different position.
 */
export const PLAN_CURSOR_TAGS = {
  /** The file-backed repository, whose payload is a plan filename. */
  file: "pf1",
  /** The process-local repository, whose payload is a plan id. */
  memory: "pm1",
  /** A provider store, whose payload is the remote's own opaque cursor. */
  provider: "pp1",
} as const;

/** One of the {@link PLAN_CURSOR_TAGS} values. */
export type PlanCursorTag = (typeof PLAN_CURSOR_TAGS)[keyof typeof PLAN_CURSOR_TAGS];

const CURSOR_SEPARATOR = ":";

const KNOWN_TAGS: readonly string[] = Object.values(PLAN_CURSOR_TAGS);

/**
 * A cursor was not minted by the store being asked to page with it.
 *
 * @remarks Extends `RangeError` because that is what an unusable cursor already
 * raised on this argument (`assertPlanLocator`), so a caller catching the old
 * shape keeps working; the distinct `name` is what lets a dispatcher classify it
 * as a caller mistake rather than as a Clarvis defect.
 */
export class PlanCursorError extends RangeError {
  /** Stable in-process discriminator. */
  readonly code = "plan_cursor_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "PlanCursorError";
  }
}

/**
 * Stamp one backend's raw paging position with the dialect it belongs to.
 *
 * @param tag - the minting backend's dialect.
 * @param value - that backend's own opaque position.
 * @returns the cursor a caller passes back verbatim.
 */
export function encodePlanCursor(tag: PlanCursorTag, value: string): string {
  return `${tag}${CURSOR_SEPARATOR}${value}`;
}

/**
 * Recover a backend's own paging position from a cursor it minted.
 *
 * @param tag - the dialect the calling backend pages in.
 * @param cursor - the cursor a caller supplied.
 * @returns the raw position, with the tag removed.
 * @throws {@link PlanCursorError} when the cursor carries another backend's tag,
 *   no tag at all, or an empty position. The message names the two dialects and
 *   never echoes the payload, which can be a filename.
 */
export function decodePlanCursor(tag: PlanCursorTag, cursor: string): string {
  const prefix = `${tag}${CURSOR_SEPARATOR}`;
  if (cursor.startsWith(prefix)) {
    const value = cursor.slice(prefix.length);
    if (value.length === 0)
      throw new PlanCursorError(`Plan cursor '${tag}' carries no paging position`);
    return value;
  }
  const separator = cursor.indexOf(CURSOR_SEPARATOR);
  const found = separator === -1 ? undefined : cursor.slice(0, separator);
  const origin =
    found !== undefined && KNOWN_TAGS.includes(found)
      ? `was minted by the '${found}' plan backend`
      : "carries no plan paging tag";
  throw new PlanCursorError(
    `Plan cursor ${origin} and cannot page a '${tag}' one; ` +
      "page from a next_cursor this backend returned",
  );
}
