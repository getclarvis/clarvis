import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { PersistenceError, type ExecutionVisibility, type TraceEvent } from "@clarvis/capability";
import { JOURNAL_VERSION } from "./journal.ts";

/**
 * Replay one immutable byte prefix with bounded reads and no retained event array.
 * Unlike crash salvage, an evidence reader refuses partial, malformed or oversized lines.
 * Owner, execution and disclosure class are checked before yielding any event.
 */
export function readJournalEvents(
  path: string,
  expected: {
    owner: string;
    id: string;
    visibility: ExecutionVisibility;
  },
): Iterable<TraceEvent> {
  let cut: number;
  try {
    cut = statSync(path).size;
  } catch {
    throw new PersistenceError("Trace journal is unavailable");
  }
  return {
    *[Symbol.iterator]() {
      let fd: number | undefined;
      try {
        fd = openSync(path, "r");
        if (fstatSync(fd).size < cut)
          throw new PersistenceError("Trace journal prefix disappeared");
        const buffer = Buffer.alloc(64 * 1024);
        let remainder = Buffer.alloc(0);
        let position = 0;
        let header = false;
        while (position < cut) {
          const count = readSync(fd, buffer, 0, Math.min(buffer.length, cut - position), position);
          if (count === 0) throw new PersistenceError("Trace journal prefix is incomplete");
          position += count;
          const bytes = Buffer.concat([remainder, buffer.subarray(0, count)]);
          let start = 0;
          for (;;) {
            const end = bytes.indexOf(10, start);
            if (end < 0) break;
            if (end - start > 8 * 1024 * 1024)
              throw new PersistenceError("Trace journal line exceeds its bound");
            let value: Record<string, unknown>;
            try {
              const decoded: unknown = JSON.parse(bytes.subarray(start, end).toString("utf8"));
              if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
                throw new Error("Invalid journal envelope");
              value = decoded as Record<string, unknown>;
            } catch {
              throw new PersistenceError("Trace journal line is malformed");
            }
            start = end + 1;
            if (!header) {
              if (
                value.v !== JOURNAL_VERSION ||
                value.owner_key_name !== expected.owner ||
                value.id !== expected.id ||
                value.visibility !== expected.visibility
              )
                throw new PersistenceError("Trace journal identity does not match its reader");
              header = true;
            } else {
              if (typeof value.type !== "string")
                throw new PersistenceError("Trace journal event is malformed");
              yield value as unknown as TraceEvent;
            }
          }
          remainder = Buffer.from(bytes.subarray(start));
          if (remainder.length > 8 * 1024 * 1024)
            throw new PersistenceError("Trace journal line exceeds its bound");
        }
        if (!header || remainder.length !== 0)
          throw new PersistenceError("Trace journal prefix is incomplete");
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw new PersistenceError("Trace journal could not be read");
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
  };
}
