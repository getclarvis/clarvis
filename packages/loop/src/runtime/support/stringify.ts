/**
 * Coerce any value to a string without throwing.
 *
 * @param value - the value to render.
 * @returns the value unchanged if already a string; otherwise its JSON
 *   encoding, falling back to `String(value)` when JSON is `undefined` (e.g. a
 *   bare `undefined`) or serialization throws (e.g. a circular reference).
 */
export function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
