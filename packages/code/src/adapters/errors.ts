/**
 * Extract a display string from an unknown thrown value.
 *
 * @remarks
 * A local copy of `@clarvis/kernel/policy`'s `errorText`, kept identical and
 * pinned by `tests/unit/errors.test.ts`.
 *
 * The duplication buys a great deal. This file used to be a single re-export,
 * and fourteen modules across `code/src` import it — including several on the
 * path evaluated before the first frame. `kernel/src/policy.ts` re-exports the
 * run-event mappers and reaches `@clarvis/loop/host`, so that one line dragged
 * roughly 250 files and several hundred zod schema constructions onto the
 * pre-paint module graph, to obtain a two-line function.
 *
 * @param e - any caught value.
 * @returns `e.message` when `e` is an {@link Error}, otherwise `String(e)`.
 */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
