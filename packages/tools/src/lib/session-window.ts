import { ToolError } from "../errors.ts";

export interface OutputSlice {
  readonly text: string;
  readonly nextOffset: number;
  readonly omittedBefore: number;
  readonly more: boolean;
}

function utf8Start(bytes: Buffer, start: number): number {
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return start;
}

/** A bounded UTF-8 tail with an absolute byte offset independent of presentation. */
export class SessionWindow {
  private bytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private firstOffset = 0;
  private endOffset = 0;

  constructor(private readonly capacity: number) {}

  get totalBytes(): number {
    return this.endOffset;
  }

  push(text: string): void {
    const incoming = Buffer.from(text, "utf8");
    this.endOffset = Math.min(Number.MAX_SAFE_INTEGER, this.endOffset + incoming.length);
    const combined = Buffer.concat([this.bytes, incoming]);
    const start = utf8Start(combined, Math.max(0, combined.length - this.capacity));
    this.bytes = Buffer.from(combined.subarray(start));
    this.firstOffset = this.endOffset - this.bytes.length;
  }

  read(offset: number, limit: number): OutputSlice {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.endOffset)
      throw new ToolError("invalid_input", "Invalid session output cursor");
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new ToolError("invalid_input", "Invalid session output limit");
    const omittedBefore = Math.max(0, this.firstOffset - offset);
    const start = utf8Start(this.bytes, Math.max(offset, this.firstOffset) - this.firstOffset);
    let end = Math.min(this.bytes.length, start + limit);
    while (end > start && end < this.bytes.length && (this.bytes[end]! & 0xc0) === 0x80) end--;
    if (end === start && start < this.bytes.length) {
      end = utf8Start(this.bytes, start + 1);
    }
    const nextOffset = this.firstOffset + end;
    return {
      text: this.bytes.subarray(start, end).toString("utf8"),
      nextOffset,
      omittedBefore,
      more: nextOffset < this.endOffset,
    };
  }
}

export interface StreamCursor {
  readonly stdout: number;
  readonly stderr: number;
}

/** The cursor format is private to one tool result; callers only return it unchanged. */
export function encodeCursor(cursor: StreamCursor): string {
  return Buffer.from(JSON.stringify([cursor.stdout, cursor.stderr]), "utf8").toString("base64url");
}

export function decodeCursor(value: string | undefined): StreamCursor {
  if (value === undefined) return { stdout: 0, stderr: 0 };
  if (value.length > 64 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new ToolError("invalid_input", "Invalid session output cursor");
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !parsed.every((offset) => Number.isSafeInteger(offset) && offset >= 0) ||
      encodeCursor({ stdout: parsed[0] as number, stderr: parsed[1] as number }) !== value
    )
      throw new Error("invalid cursor");
    return { stdout: parsed[0] as number, stderr: parsed[1] as number };
  } catch {
    throw new ToolError("invalid_input", "Invalid session output cursor");
  }
}
