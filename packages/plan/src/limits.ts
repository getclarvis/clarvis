/**
 * Hard resource bounds shared by every plan surface.
 *
 * The Markdown file remains the canonical document, but neither a hand-edited
 * workspace nor a provider/tool payload may turn one plan operation into an
 * unbounded allocation. Keep these values in one dependency-free module so the
 * schemas, repository and runtime tools cannot silently drift.
 */

/** Maximum UTF-8 size of one canonical plan Markdown document (8 MiB). */
export const MAX_PLAN_DOCUMENT_BYTES = 8 * 1024 * 1024;
/** Maximum canonical source bytes retained in one list page (32 MiB). */
export const MAX_PLAN_LIST_PAGE_BYTES = 32 * 1024 * 1024;
/** Prefix inspected while discovering the `id` in YAML frontmatter (64 KiB). */
export const MAX_PLAN_FRONTMATTER_BYTES = 64 * 1024;
/** Maximum number of directory entries inspected by one repository operation. */
export const MAX_PLAN_DIRECTORY_ENTRIES = 10_000;
/** Number of candidate filenames retained while walking a directory. */
export const MAX_PLAN_FILENAME_WINDOW = 256;

/**
 * Maximum tasks in one plan.
 *
 * @remarks Not a working limit. The plan is a Markdown document a human opens,
 * reads and follows while the run is live, so it stops being usable an order of
 * magnitude below this — a plan that genuinely needs hundreds of tasks is a plan
 * that should have been split, and the session already supports sealing one and
 * starting the next. What this bound actually does is refuse a generated or
 * runaway plan before it reaches the document, the digest and the renderer.
 * {@link MAX_PLAN_VALIDATION_ITEMS} matches it because the two lists have the
 * same shape and the same reader.
 */
export const MAX_PLAN_TASKS = 256;
/** Maximum validation checks in one plan; see {@link MAX_PLAN_TASKS}. */
export const MAX_PLAN_VALIDATION_ITEMS = 256;
/**
 * Maximum revisions or task transitions accepted in one atomic batch.
 *
 * @remarks A batch is meant to carry **one decision**, which is why the bound is
 * a fraction of {@link MAX_PLAN_TASKS} rather than equal to it: batching exists
 * because a caller holds exactly one compare-and-swap triple, not to let a
 * caller rewrite the whole plan in a single fold. The fold is also
 * all-or-nothing, so an oversized batch is one whose rejection wastes the most
 * work.
 */
export const MAX_PLAN_BATCH_OPERATIONS = 128;

/** Maximum stable id/cursor/path-like input length. */
export const MAX_PLAN_LOCATOR_CHARS = 1_024;
/** Maximum plan title length. */
export const MAX_PLAN_TITLE_CHARS = 1_024;
/** Maximum task title length. */
export const MAX_PLAN_TASK_TITLE_CHARS = 1_024;
/** Maximum objective, context, notes, or extra-section length. */
export const MAX_PLAN_SECTION_CHARS = 1024 * 1024;
/** Maximum detail/outcome text on one task field. */
export const MAX_PLAN_TASK_FIELD_CHARS = 64 * 1024;
/** Maximum assignee identifier length. */
export const MAX_PLAN_ASSIGNEE_CHARS = 1_024;
/** Maximum length of one validation item. */
export const MAX_PLAN_VALIDATION_ITEM_CHARS = 8 * 1024;
/** Maximum sum of controlled plan prose retained in a parsed document. */
export const MAX_PLAN_TEXT_CHARS = 4 * 1024 * 1024;
/** Maximum number of preserved unknown frontmatter keys or extra sections. */
export const MAX_PLAN_EXTENSION_FIELDS = 256;
/** Maximum length of a preserved frontmatter key or extra-section heading. */
export const MAX_PLAN_EXTENSION_KEY_CHARS = 1_024;

/** Return the UTF-8 byte length without allocating a second encoded string. */
export function planSourceByteLength(source: string): number {
  return Buffer.byteLength(source, "utf8");
}

/** Reject a source before it can reach an adapter or atomic-write buffer. */
export function assertPlanSourceSize(source: string): void {
  const bytes = planSourceByteLength(source);
  if (bytes > MAX_PLAN_DOCUMENT_BYTES) {
    throw new RangeError(
      `Plan document exceeds ${MAX_PLAN_DOCUMENT_BYTES} UTF-8 bytes (received ${bytes})`,
    );
  }
}
