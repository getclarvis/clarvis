/**
 * Test whether a string parses as an absolute `http:`/`https:` URL.
 *
 * @param value - the candidate URL string.
 * @returns `true` only if `value` parses via {@link URL} and its protocol is
 *   `http:` or `https:`; `false` for unparseable input or any other scheme.
 */
export function isWellFormedHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}
