import { DIR_MODE, FILE_MODE, workspaceStatePaths } from "@clarvis/paths";
import { closeSync, fstatSync, openSync, promises as fs, readSync } from "node:fs";
import { dirname } from "node:path";
import {
  createPromptHistory,
  type PromptHistory,
  type PromptHistoryOptions,
  type PromptHistoryPersistence,
  type PromptHistorySnapshot,
} from "../core/prompt-history.ts";

/** The durable history is a convenience cache, not an unbounded transcript. */
const MAX_PROMPT_HISTORY_FILE_BYTES = 8 * 1024 * 1024;

function encode(entries: readonly string[]): string {
  return entries.map((entry) => JSON.stringify(entry) + "\n").join("");
}

function loadEntries(file: string, limit: number): PromptHistorySnapshot {
  let raw: string;
  let truncated: boolean;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, MAX_PROMPT_HISTORY_FILE_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    const start = Math.max(0, size - length);
    let read = 0;
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, start + read);
      if (count === 0) break;
      read += count;
    }
    truncated = start > 0;
    raw = buffer.subarray(0, read).toString("utf8");
  } catch {
    return { entries: [], compact: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  const newest: string[] = [];
  let end = raw.length;
  while (end > 0 && newest.length < limit) {
    while (end > 0 && raw.charCodeAt(end - 1) === 10) end -= 1;
    if (end === 0) break;
    const newline = raw.lastIndexOf("\n", end - 1);
    const start = newline + 1;
    if (truncated && start === 0) break; // The tail starts inside an older JSON line.
    const line = raw.slice(start, end);
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "string" && value.length > 0) newest.push(value);
    } catch {
      // A corrupt line does not hide the remaining usable history.
    }
    end = newline < 0 ? 0 : newline;
  }
  newest.reverse();
  return { entries: newest, compact: truncated || end > 0 };
}

/** Creates the JSONL filesystem adapter for one prompt-history file. */
function createFilePromptHistoryPersistence(file: string): PromptHistoryPersistence {
  return {
    path: file,
    load: (limit) => loadEntries(file, limit),
    append: async (text) => {
      await fs.mkdir(dirname(file), { recursive: true, mode: DIR_MODE });
      await fs.appendFile(file, JSON.stringify(text) + "\n", { mode: FILE_MODE });
    },
    compact: async (entries) => {
      await fs.mkdir(dirname(file), { recursive: true, mode: DIR_MODE });
      await fs.writeFile(file, encode(entries), { mode: FILE_MODE });
    },
  };
}

/**
 * Creates file-backed prompt history in the workspace's machine-local state
 * tree. Passing a file keeps tests and alternate hosts deterministic.
 */
export function createFilePromptHistory(
  limit = 200,
  file = workspaceStatePaths().promptHistoryFile,
  options: PromptHistoryOptions = {},
): PromptHistory {
  return createPromptHistory(limit, createFilePromptHistoryPersistence(file), options);
}
