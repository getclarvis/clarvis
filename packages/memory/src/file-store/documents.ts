import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import * as path from "node:path";

import { isTmpFile, writeFileAtomic } from "@clarvis/paths";

import { readUtf8FileBounded, scanDirectoryBounded } from "../bounded-io.ts";
import { parseFrontmatter } from "../frontmatter.ts";
import { compareMemoryPaths, memoryDocKind, normalizeMemoryPath } from "../paths.ts";
import {
  assertMemoryPayloadBytes,
  assertMemoryStorageCount,
  MEMORY_STORAGE_LIMITS,
  MemoryStorageLimitError,
} from "../storage-limits.ts";
import { createGrepScanner, grepHitText } from "../text/grep.ts";
import type { GrepHit, MemoryDoc, MemoryTx } from "../types.ts";

type DocumentRepository = Pick<
  MemoryTx,
  "read" | "readBounded" | "write" | "delete" | "list" | "grep" | "version"
>;

export function createDocumentRepository(options: {
  root: string;
  init: () => Promise<void>;
  clock: () => number;
  /** Internal test seam; production callers always use the package hard limit. */
  scanEntries?: number;
  /** Internal test seam for exact aggregate-boundary coverage. */
  corpusBytes?: number;
}): DocumentRepository {
  const closeBestEffort = async (
    handle: Awaited<ReturnType<typeof fs.open>> | undefined,
  ): Promise<void> => {
    try {
      await handle?.close();
    } catch {}
  };
  const abs = (relPath: string): string => path.join(options.root, normalizeMemoryPath(relPath));
  const scanEntries = Math.min(
    MEMORY_STORAGE_LIMITS.scanEntries,
    Math.max(0, Math.trunc(options.scanEntries ?? MEMORY_STORAGE_LIMITS.scanEntries)),
  );
  const corpusLimit = Math.min(
    MEMORY_STORAGE_LIMITS.corpusBytes,
    Math.max(0, Math.trunc(options.corpusBytes ?? MEMORY_STORAGE_LIMITS.corpusBytes)),
  );

  async function readText(file: string): Promise<string | null> {
    return (
      (
        await readUtf8FileBounded(file, {
          maxBytes: MEMORY_STORAGE_LIMITS.documentBytes,
          kind: "document",
        })
      )?.text ?? null
    );
  }

  async function walk(): Promise<{ files: string[]; inspected: number; truncated: boolean }> {
    await options.init();
    const out: string[] = [];
    const stack = [""];
    let visited = 0;
    // Keep opening already-discovered directories after the entry budget is
    // exhausted. Passing a zero remainder lets scanDirectoryBounded perform one
    // look-ahead: an empty pending subtree completes without a false positive,
    // while its first real entry proves that the catalog is incomplete.
    while (stack.length > 0) {
      const rel = stack.pop() as string;
      const dir = rel === "" ? options.root : path.join(options.root, rel);
      const remaining = Math.max(0, scanEntries - visited);
      const scan = await scanDirectoryBounded(dir, remaining, (entry) => {
        if (!entry.name.startsWith(".")) {
          const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
          if (entry.isDirectory()) stack.push(child);
          else if (entry.isFile() && entry.name.endsWith(".md") && !isTmpFile(entry.name)) {
            out.push(child);
          }
        }
      });
      visited += scan.inspected;
      if (scan.truncated) break;
    }
    return {
      files: out.sort(compareMemoryPaths),
      inspected: visited,
      truncated: visited > scanEntries,
    };
  }

  function assertWalkComplete(walked: { inspected: number; truncated: boolean }): void {
    if (!walked.truncated) return;
    assertMemoryStorageCount("entries", options.root, walked.inspected, scanEntries);
  }

  async function hashFileBounded(
    file: string,
    hash: ReturnType<typeof createHash>,
    currentCorpus: number,
  ): Promise<number> {
    let handle;
    try {
      handle = await fs.open(file, "r");
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`memory: path is not a regular file: ${file}`);
      if (stat.size > MEMORY_STORAGE_LIMITS.documentBytes) {
        throw new MemoryStorageLimitError({
          kind: "document",
          identifier: file,
          actual: stat.size,
          maximum: MEMORY_STORAGE_LIMITS.documentBytes,
        });
      }
      assertMemoryStorageCount("corpus", "memory version", currentCorpus + stat.size, corpusLimit);
      hash.update(String(stat.size)).update("\0");
      let bytesRead = 0;
      if (stat.size > 0) {
        for await (const chunk of handle.createReadStream({
          autoClose: false,
          start: 0,
          end: stat.size - 1,
          highWaterMark: 64 * 1024,
        })) {
          const buffer = chunk as Buffer;
          bytesRead += buffer.byteLength;
          hash.update(buffer);
        }
      }
      const after = await handle.stat();
      if (after.size !== stat.size || bytesRead !== stat.size) {
        throw new Error(`memory: file changed while it was being hashed: ${file}`);
      }
      return stat.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return 0;
    } finally {
      await closeBestEffort(handle);
    }
  }

  return {
    async read(relPath) {
      return readText(abs(relPath));
    },
    async readBounded(relPath, maxBytes) {
      const maximum = Math.max(
        0,
        Math.min(Math.trunc(maxBytes), MEMORY_STORAGE_LIMITS.documentBytes),
      );
      const result = await readUtf8FileBounded(abs(relPath), {
        maxBytes: maximum,
        kind: "document",
        truncate: true,
      });
      return result === null ? null : { text: result.text, truncated: result.truncated };
    },
    async write(relPath, content) {
      const file = abs(relPath);
      assertMemoryPayloadBytes("document", file, content, MEMORY_STORAGE_LIMITS.documentBytes);
      await writeFileAtomic(file, content);
    },
    async delete(relPath) {
      try {
        await fs.unlink(abs(relPath));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async list() {
      const docs: MemoryDoc[] = [];
      let corpusBytes = 0;
      const walked = await walk();
      assertWalkComplete(walked);
      for (const rel of walked.files) {
        const file = path.join(options.root, rel);
        const bounded = await readUtf8FileBounded(file, {
          maxBytes: MEMORY_STORAGE_LIMITS.prefixBytes,
          kind: "document",
          truncate: true,
        });
        if (bounded === null) continue;
        assertMemoryStorageCount("corpus", options.root, corpusBytes + bounded.bytes, corpusLimit);
        corpusBytes += bounded.bytes;
        let updated_at = options.clock();
        try {
          updated_at = (await fs.stat(file)).mtimeMs;
        } catch {}
        const { frontmatter } = parseFrontmatter(bounded.text);
        docs.push({
          path: rel,
          kind: memoryDocKind(rel),
          description: frontmatter.description,
          tags: frontmatter.tags,
          updated_at,
        });
      }
      return docs;
    },
    async grep(query, grepOptions = {}) {
      const limit = grepOptions.limit ?? 20;
      const hits: GrepHit[] = [];
      const scanner = createGrepScanner(query, grepOptions);
      let corpusBytes = 0;
      const walked = await walk();
      assertWalkComplete(walked);
      for (const rel of walked.files) {
        if (!scanner.ok()) return hits;
        let handle;
        try {
          handle = await fs.open(path.join(options.root, rel), "r");
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MEMORY_STORAGE_LIMITS.documentBytes) {
            continue;
          }
          assertMemoryStorageCount("corpus", options.root, corpusBytes + stat.size, corpusLimit);
          corpusBytes += stat.size;
          if (stat.size === 0) continue;
          const lines = createInterface({
            input: handle.createReadStream({ autoClose: false, start: 0, end: stat.size - 1 }),
            crlfDelay: Infinity,
          });
          let lineNumber = 0;
          for await (const line of lines) {
            lineNumber += 1;
            if (!scanner.ok()) return hits;
            if (scanner.match(line)) {
              hits.push({ path: rel, line: lineNumber, text: grepHitText(line) });
              if (hits.length >= limit) return hits;
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        } finally {
          await closeBestEffort(handle);
        }
      }
      return hits;
    },
    async version() {
      const hash = createHash("sha256");
      let corpusBytes = 0;
      const walked = await walk();
      assertWalkComplete(walked);
      for (const rel of walked.files) {
        hash.update(rel).update("\0");
        corpusBytes += await hashFileBounded(path.join(options.root, rel), hash, corpusBytes);
        hash.update("\0");
      }
      return hash.digest("hex");
    },
  };
}
