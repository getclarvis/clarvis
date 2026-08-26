/**
 * Extract a display string from an unknown thrown value.
 *
 * @param e - any caught value.
 * @returns `e.message` when `e` is an {@link Error}, otherwise `String(e)`.
 */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
