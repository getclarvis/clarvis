import { ToolError } from "../errors.ts";
import { isBinary, isUtf16Bom } from "./binary.ts";
import { decodeText, type DecodedText } from "./text.ts";
import { readRawFile, type ReadFileOptions } from "./files.ts";

/**
 * Reject a buffer that looks like binary, unless it opens with a UTF-16 BOM.
 *
 * @param buf - the raw file bytes.
 * @param relForError - the workspace-relative path echoed into the error.
 * @throws {@link ToolError} with code `is_binary` when the bytes contain a NUL.
 * @remarks A UTF-16 file is full of NUL bytes and would otherwise trip the binary
 *   heuristic, so a leading UTF-16 BOM ({@link isUtf16Bom}) exempts it from the
 *   check and lets {@link decodeText} handle the encoding.
 */
function rejectIfUnreadable(buf: Buffer, relForError: string): void {
  if (isUtf16Bom(buf)) return;
  if (isBinary(buf)) {
    throw new ToolError("is_binary", `File appears to be binary: ${relForError}`, {
      path: relForError,
    });
  }
}

/**
 * Read a text file, enforcing the size ceiling and rejecting binary content, and
 * return it decoded with its encoding/EOL/BOM metadata.
 *
 * @param target - the absolute path to read.
 * @param relForError - the workspace-relative path echoed into error messages.
 * @param maxBytes - the maximum file size to accept (the `MAX_FILE_BYTES` limit).
 * @param options - descriptor and post-open confinement policy.
 * @returns the {@link DecodedText} for the file.
 * @throws {@link ToolError} for a missing/oversized/non-file path (see
 *   {@link readRawFile}) or `is_binary` when the bytes look binary and lack a
 *   UTF-16 BOM.
 */
export async function readTextFile(
  target: string,
  relForError: string,
  maxBytes: number,
  options: ReadFileOptions = {},
): Promise<DecodedText> {
  const buf = await readRawFile(target, relForError, maxBytes, "MAX_FILE_BYTES", options);
  rejectIfUnreadable(buf, relForError);
  return decodeText(buf);
}

/**
 * Best-effort read of a text file: return its decoded content, or `null` when it
 * is absent, oversized, unreadable, or binary.
 *
 * @param target - the absolute path to read.
 * @param maxBytes - the maximum file size to accept.
 * @param options - descriptor and post-open confinement policy.
 * @returns the {@link DecodedText}, or `null` on any of the above conditions.
 * @remarks Unlike {@link readTextFile}, ordinary filesystem, size and binary
 *   failures collapse to `null`, so it suits callers that treat an unavailable
 *   file as simply absent. A post-open `path_escape` is deliberately re-thrown:
 *   security-boundary races must not masquerade as an empty search result.
 */
export async function readTextBuffer(
  target: string,
  maxBytes: number,
  options: ReadFileOptions = {},
): Promise<DecodedText | null> {
  let buf: Buffer;
  try {
    buf = await readRawFile(target, target, maxBytes, undefined, options);
  } catch (err) {
    if (err instanceof ToolError && err.code === "path_escape") throw err;
    return null;
  }
  if (isBinary(buf)) return null;
  return decodeText(buf);
}
