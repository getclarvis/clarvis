import { promises as fs } from "node:fs";
import { bestEffortFileStore } from "./tasks.ts";
import * as path from "node:path";

import { writeFileDurable } from "@clarvis/paths";

import { MEMORY_DEFAULTS } from "../config.ts";
import { readUtf8FileBounded, scanDirectoryBounded } from "../bounded-io.ts";
import { normalizeMemoryPath } from "../paths.ts";
import { compareRevisionsNewestFirst, type MemoryRevision } from "../revisions.ts";
import { assertMemoryPayloadBytes, MEMORY_STORAGE_LIMITS } from "../storage-limits.ts";
import type { MemoryRevisionReader } from "../types.ts";

export interface RevisionRepository extends MemoryRevisionReader {
  put(revision: MemoryRevision, body: string): Promise<void>;
  lastInstalledDigest(relPath: string): Promise<string | undefined>;
  prune(paths: readonly string[], now: number): Promise<void>;
}

function isRevision(value: unknown, id: string, relPath: string): value is MemoryRevision {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const revision = value as Partial<MemoryRevision>;
  return (
    revision.id === id &&
    revision.path === relPath &&
    typeof revision.at === "number" &&
    (revision.op === "write" || revision.op === "delete") &&
    typeof revision.bytes === "number" &&
    typeof revision.batch_id === "string" &&
    revision.source !== null &&
    typeof revision.source === "object" &&
    (revision.digest === undefined || typeof revision.digest === "string") &&
    (revision.previous_digest === undefined || typeof revision.previous_digest === "string") &&
    (revision.external_edit === undefined || typeof revision.external_edit === "boolean")
  );
}

export function createRevisionRepository(options: {
  machineryRoot: string;
  init: () => Promise<void>;
}): RevisionRepository {
  const dirFor = (relPath: string): string =>
    path.join(options.machineryRoot, ".history", normalizeMemoryPath(relPath));

  async function list(relPath: string): Promise<MemoryRevision[]> {
    await options.init();
    const normalized = normalizeMemoryPath(relPath);
    const dir = dirFor(normalized);
    const revisions: MemoryRevision[] = [];
    let corpusBytes = 0;
    await scanDirectoryBounded(dir, MEMORY_STORAGE_LIMITS.scanEntries, async (entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return;
      const raw = await readUtf8FileBounded(path.join(dir, entry.name), {
        maxBytes: MEMORY_STORAGE_LIMITS.metadataBytes,
        kind: "metadata",
        truncate: true,
      }).catch(() => null);
      if (raw === null || raw.truncated) return;
      if (corpusBytes + raw.bytes > MEMORY_STORAGE_LIMITS.corpusBytes) return false;
      corpusBytes += raw.bytes;
      try {
        const id = entry.name.slice(0, -".json".length);
        const revision: unknown = JSON.parse(raw.text);
        if (!isRevision(revision, id, normalized)) return;
        revisions.push(revision);
      } catch {}
    });
    return revisions.sort(compareRevisionsNewestFirst);
  }

  return {
    list,
    async read(relPath, revisionId) {
      if (!(await list(relPath)).some((revision) => revision.id === revisionId)) return null;
      return (
        (
          await readUtf8FileBounded(path.join(dirFor(relPath), `${revisionId}.md`), {
            maxBytes: MEMORY_STORAGE_LIMITS.revisionBodyBytes,
            kind: "revision body",
          })
        )?.text ?? null
      );
    },
    async put(revision, body) {
      const dir = dirFor(revision.path);
      const metadata = JSON.stringify(revision);
      assertMemoryPayloadBytes(
        "revision body",
        `${revision.path}@${revision.id}`,
        body,
        MEMORY_STORAGE_LIMITS.revisionBodyBytes,
      );
      assertMemoryPayloadBytes(
        "metadata",
        `${revision.path}@${revision.id}`,
        metadata,
        MEMORY_STORAGE_LIMITS.metadataBytes,
      );
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFileDurable(path.join(dir, `${revision.id}.md`), body);
      await writeFileDurable(path.join(dir, `${revision.id}.json`), metadata);
    },
    async lastInstalledDigest(relPath) {
      return (await list(relPath))[0]?.digest;
    },
    async prune(paths, now) {
      const policy = MEMORY_DEFAULTS.history;
      const cutoff = now - policy.keep_days * 86_400_000;
      for (const relPath of paths) {
        const revisions = await list(relPath);
        const doomed = revisions.filter(
          (revision, index) =>
            index >= policy.min_revisions &&
            (index >= policy.keep_revisions || revision.at < cutoff),
        );
        for (const revision of doomed) {
          await bestEffortFileStore("memory_revision_metadata_prune", () =>
            fs.rm(path.join(dirFor(relPath), `${revision.id}.json`), { force: true }),
          );
          await bestEffortFileStore("memory_revision_body_prune", () =>
            fs.rm(path.join(dirFor(relPath), `${revision.id}.md`), { force: true }),
          );
        }
      }
    },
  };
}
