import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { errorText } from "../error-text.ts";

/**
 * One source of truth for every filesystem input a plugin can make Clarvis retain or parse.
 *
 * @remarks Count limits bound directory traversal; byte limits bound allocation and parsing.
 * The aggregate agent ceiling is deliberately lower than `files * fileBytes`, so many legal
 * individual documents cannot multiply into an oversized plugin snapshot.
 */
export const PLUGIN_RESOURCE_LIMITS = Object.freeze({
  agentDepth: 8,
  agentDirectories: 128,
  agentEntries: 2_048,
  agentFiles: 256,
  agentFileBytes: 256 * 1024,
  agentAggregateBytes: 8 * 1024 * 1024,
  manifestLocationEntries: 256,
  installRootEntries: 2_048,
  skillDirectoryEntries: 512,
  manifestBytes: 2 * 1024 * 1024,
  hookDocumentBytes: 2 * 1024 * 1024,
  installRecordBytes: 64 * 1024,
});

/** A descriptor-backed plugin text read, or an explicit bounded-read failure. */
export type BoundedPluginTextResult =
  { ok: true; text: string; bytes: number } | { ok: false; error: string; missing?: true };

/**
 * Read at most `maxBytes` from one regular plugin file before parsing it.
 *
 * @remarks The path is opened once and the same descriptor is sized and read with one byte of
 * lookahead. Replacement cannot switch the inode after validation, and growth between `fstat` and
 * `read` cannot bypass the ceiling. `O_NONBLOCK` prevents a repository FIFO from pinning startup;
 * `O_NOFOLLOW`, where the host exposes it, avoids following a late symlink replacement.
 */
export function readBoundedPluginText(
  path: string,
  maxBytes: number,
  label: string,
): BoundedPluginTextResult {
  let fd: number;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      ok: false,
      error: `${label} could not be opened: ${errorText(error)}`,
      ...(missing ? { missing: true } : {}),
    };
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, error: `${label} is not a regular file` };
    if (stat.size > maxBytes) {
      return {
        ok: false,
        error: `${label} exceeds the ${String(maxBytes)}-byte resource limit`,
      };
    }

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = readSync(fd, buffer, total, buffer.length - total, null);
      if (read === 0) break;
      total += read;
    }
    if (total > maxBytes) {
      return {
        ok: false,
        error: `${label} exceeds the ${String(maxBytes)}-byte resource limit`,
      };
    }
    return { ok: true, text: buffer.subarray(0, total).toString("utf8"), bytes: total };
  } catch (error) {
    return { ok: false, error: `${label} could not be read: ${errorText(error)}` };
  } finally {
    closeSync(fd);
  }
}
