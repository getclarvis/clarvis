import { diffArrays } from "diff";

const BOM = "﻿";

/** The dominant line ending detected in a file: `"lf"` (`\n`) or `"crlf"` (`\r\n`). */
export type Eol = "lf" | "crlf";

/** The byte encoding detected for a file: UTF-8, or little/big-endian UTF-16. */
export type Encoding = "utf8" | "utf16le" | "utf16be";

/**
 * The result of decoding a file's bytes: its normalized text plus the metadata
 * needed to re-encode it in the same shape (see {@link encodeText} /
 * {@link reencode}).
 */
export interface DecodedText {
  /** The text with all line endings normalized to `\n` and any BOM stripped. */
  content: string;

  /** The dominant original line ending, so a rewrite can restore it. */
  eol: Eol;

  /** Whether the source began with a byte-order mark. */
  bom: boolean;

  /** The decoded text before EOL normalization (BOM already removed); retains the original `\r\n`/`\r`. */
  raw: string;

  /** The byte encoding the source was decoded from. */
  encoding: Encoding;
}

/**
 * Decode a file's bytes into normalized text plus the metadata to reproduce its
 * original encoding, BOM, and line endings.
 *
 * @param buf - the raw file bytes.
 * @returns a {@link DecodedText}; `content` has all EOLs normalized to `\n` and
 *   any BOM removed, while `raw`/`eol`/`bom`/`encoding` capture the original
 *   shape.
 * @remarks Encoding is chosen from the leading bytes: a UTF-16 LE/BE BOM selects
 *   UTF-16 (a big-endian body is byte-swapped before decoding), otherwise the
 *   bytes are read as UTF-8 and a leading `U+FEFF` is treated as a BOM. `eol` is
 *   whichever of CRLF/LF occurs more often, defaulting to `lf` for a file with no
 *   line breaks.
 */
export function decodeText(buf: Buffer): DecodedText {
  let encoding: Encoding = "utf8";
  let raw: string;
  let bom = false;

  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    encoding = "utf16le";
    bom = true;
    raw = buf.subarray(2).toString("utf16le");
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    encoding = "utf16be";
    bom = true;
    const body = buf.subarray(2);
    const even = body.length - (body.length % 2);
    const swapped = Buffer.from(body.subarray(0, even));
    swapped.swap16();
    raw = swapped.toString("utf16le");
  } else {
    raw = buf.toString("utf8");
    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
      bom = true;
    }
  }

  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) === 0x0a) {
      if (i > 0 && raw.charCodeAt(i - 1) === 0x0d) crlf++;
      else lf++;
    }
  }

  const eol: Eol = crlf > lf ? "crlf" : "lf";

  const content = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return { content, eol, bom, raw, encoding };
}

/**
 * Re-apply a uniform line ending and optional BOM to text before writing it back.
 *
 * @param content - the text to encode (any mix of line endings).
 * @param opts - `eol` is the ending to enforce; `bom` prepends a byte-order mark
 *   when set.
 * @returns the encoded string (still a JavaScript UTF-16 string; byte encoding
 *   is the caller's concern).
 * @remarks All existing endings are first normalized to `\n`, then converted to
 *   `\r\n` when `eol` is `crlf`, so the whole file ends up consistent. For
 *   per-line preservation of mixed endings use {@link reencode} instead.
 */
export function encodeText(content: string, opts: { eol: Eol; bom: boolean }): string {
  let out = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (opts.eol === "crlf") {
    out = out.replace(/\n/g, "\r\n");
  }
  return opts.bom ? BOM + out : out;
}

/**
 * Split text on `\n` into lines, dropping the empty trailing element a final
 * newline produces.
 *
 * @param content - the text to split (expected already normalized to `\n`).
 * @returns the lines, without their terminators and without a spurious empty last
 *   entry.
 */
export function splitLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Count the `\n` characters in a string.
 *
 * @param s - the text to scan.
 * @returns the number of newline characters (a `\r\n` counts once, via its `\n`).
 */
export function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x0a) n++;
  }
  return n;
}

interface Line {
  text: string;
  end: string;
}

function tokenize(s: string): Line[] {
  const parts = s.split(/(\r\n|\r|\n)/);
  const lines: Line[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i] ?? "";
    const end = parts[i + 1] ?? "";
    if (text === "" && end === "" && i > 0) break;
    lines.push({ text, end });
  }
  return lines;
}

function dominantEnd(lines: Line[]): string {
  const counts = new Map<string, number>();
  for (const { end } of lines) {
    if (end === "") continue;
    counts.set(end, (counts.get(end) ?? 0) + 1);
  }
  let best = "\n";
  let bestCount = 0;
  for (const [end, count] of counts) {
    if (count > bestCount) {
      best = end;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Rewrite edited text so each surviving line keeps its original line ending,
 * preserving a mixed-ending file that {@link encodeText} would flatten.
 *
 * @param newContent - the edited text to write back.
 * @param decoded - the {@link DecodedText} of the original, whose `raw` supplies
 *   the per-line endings to reuse.
 * @returns the re-encoded string, with a leading BOM re-added when the original
 *   had one.
 * @remarks A line diff between the original and edited lines maps each unchanged
 *   line back to its source ending; inserted lines and any line whose source
 *   ending is unknown or absent get the file's dominant ending. A final line
 *   without a trailing newline stays that way.
 */
export function reencode(newContent: string, decoded: DecodedText): string {
  const oldLines = tokenize(decoded.raw);
  const newLines = tokenize(newContent);
  const dominant = dominantEnd(oldLines);

  const mapped: (string | null)[] = newLines.map(() => null);
  const parts = diffArrays(
    oldLines.map((l) => l.text),
    newLines.map((l) => l.text),
  );
  let oi = 0;
  let ni = 0;
  for (const part of parts) {
    const count = part.count ?? part.value.length;
    if (part.added) {
      ni += count;
    } else if (part.removed) {
      oi += count;
    } else {
      for (let k = 0; k < count; k++) {
        mapped[ni] = oldLines[oi]?.end ?? null;
        oi++;
        ni++;
      }
    }
  }

  let out = "";
  for (let i = 0; i < newLines.length; i++) {
    const line = newLines[i];
    if (line === undefined) continue;
    out += line.text;
    if (line.end === "") continue;
    const orig = mapped[i];
    out += orig !== null && orig !== "" ? orig : dominant;
  }

  return decoded.bom ? BOM + out : out;
}
