import { opendir, lstat, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type {
  CredentialFilePosture,
  StorageCategory,
  StorageCategorySummary,
  StorageCleanupRequest,
  StorageCleanupResult,
  StorageService,
  StorageSnapshot,
} from "@clarvis/protocol";
import { globalPaths, isSpillFile, sweepGlobalStateArtifacts } from "@clarvis/paths";
import { kernelError } from "../core/errors.ts";

const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 24;
const SPILL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CATEGORIES: readonly StorageCategory[] = [
  "traces",
  "sessions",
  "workflow_records",
  "projects",
  "spills",
  "memory",
  "plans",
  "diagnostics",
  "run_scratch",
  "workspace_state",
  "cache",
];

interface MutableCategory {
  files: number;
  directories: number;
  bytes: number;
  reclaimableBytes: number;
}

function emptyCategories(): Map<StorageCategory, MutableCategory> {
  return new Map(
    CATEGORIES.map((category) => [
      category,
      { files: 0, directories: 0, bytes: 0, reclaimableBytes: 0 },
    ]),
  );
}

function workspaceCategory(path: string): StorageCategory {
  const parts = path.split(sep);
  const name = parts.at(-1) ?? "";
  if (isSpillFile(name)) return "spills";
  if (parts.includes("memory")) return "memory";
  if (parts.includes("plans")) return "plans";
  if (parts.includes("diagnostics")) return "diagnostics";
  if (parts.includes("runs")) return "run_scratch";
  return "workspace_state";
}

async function credentialPosture(path: string): Promise<CredentialFilePosture> {
  try {
    const info = await lstat(path);
    return {
      present: info.isFile() && !info.isSymbolicLink(),
      owner_only: process.platform === "win32" ? null : (info.mode & 0o077) === 0,
    };
  } catch {
    return { present: false, owner_only: null };
  }
}

interface StorageInspectionLimits {
  maxEntries?: number;
  maxDepth?: number;
}

export function createStorageService(
  globalDir: string,
  limits: StorageInspectionLimits = {},
): StorageService {
  const paths = globalPaths(globalDir);
  const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
  const maxDepth = limits.maxDepth ?? MAX_DEPTH;

  const inspect = async (): Promise<StorageSnapshot> => {
    const categories = emptyCategories();
    const roots: Array<{
      root: string;
      category: StorageCategory;
      classify?: (relativePath: string) => StorageCategory;
    }> = [
      { root: paths.tracesDir, category: "traces" },
      { root: paths.sessionsDir, category: "sessions" },
      { root: paths.workflowRecordsDir, category: "workflow_records" },
      { root: join(paths.state, "projects"), category: "projects" },
      {
        root: join(paths.state, "workspaces"),
        category: "workspace_state",
        classify: workspaceCategory,
      },
      { root: paths.cache, category: "cache" },
    ];
    let examined = 0;
    let truncated = false;
    const now = Date.now();
    for (const target of roots) {
      const pending = [{ path: target.root, depth: 0 }];
      while (pending.length > 0) {
        if (examined >= maxEntries) {
          truncated = true;
          break;
        }
        const current = pending.pop()!;
        let dir: Awaited<ReturnType<typeof opendir>>;
        try {
          dir = await opendir(current.path);
        } catch {
          continue;
        }
        try {
          for await (const entry of dir) {
            if (examined++ >= maxEntries) {
              truncated = true;
              break;
            }
            const path = join(current.path, entry.name);
            const rel = relative(target.root, path);
            const category = target.classify?.(rel) ?? target.category;
            const row = categories.get(category)!;
            if (entry.isDirectory()) {
              row.directories += 1;
              if (current.depth < maxDepth) pending.push({ path, depth: current.depth + 1 });
              else truncated = true;
              continue;
            }
            if (!entry.isFile()) continue;
            try {
              const info = await lstat(path);
              if (!info.isFile()) continue;
              row.files += 1;
              row.bytes += info.size;
              if (
                category === "cache" ||
                (category === "spills" && now - info.mtimeMs > SPILL_MAX_AGE_MS)
              ) {
                row.reclaimableBytes += info.size;
              }
            } catch {}
          }
        } finally {
          await dir.close().catch(() => undefined);
        }
        if (truncated) break;
      }
      if (truncated) break;
    }
    const summaries: StorageCategorySummary[] = CATEGORIES.map((category) => {
      const row = categories.get(category)!;
      return {
        category,
        files: row.files,
        directories: row.directories,
        bytes: row.bytes,
        reclaimable_bytes: row.reclaimableBytes,
      };
    });
    return {
      generated_at: Date.now(),
      total_bytes: summaries.reduce((total, row) => total + row.bytes, 0),
      reclaimable_bytes: summaries.reduce((total, row) => total + row.reclaimable_bytes, 0),
      truncated,
      categories: summaries,
      credentials: {
        keys: await credentialPosture(paths.keysFile),
        subscriptions: await credentialPosture(paths.subscriptionsFile),
      },
    };
  };

  return {
    inspect,
    async cleanup(request: StorageCleanupRequest): Promise<StorageCleanupResult> {
      const selected = new Set(request.categories);
      if (
        request.categories.length === 0 ||
        [...selected].some((category) => category !== "temporary" && category !== "cache")
      ) {
        throw kernelError("invalid_request", "storage cleanup requires temporary and/or cache");
      }
      const before = await inspect();
      const reclaimableBytes = before.categories
        .filter(
          (row) =>
            (selected.has("temporary") &&
              (row.category === "spills" || row.category === "run_scratch")) ||
            (selected.has("cache") && row.category === "cache"),
        )
        .reduce((total, row) => total + row.reclaimable_bytes, 0);
      if (request.dry_run) {
        return { dry_run: true, reclaimable_bytes: reclaimableBytes, removed_bytes: 0, before };
      }
      if (before.truncated) {
        throw kernelError(
          "conflict",
          "storage cleanup refused because the inventory was truncated; narrow or reduce local state before retrying",
        );
      }
      if (selected.has("temporary")) await sweepGlobalStateArtifacts(globalDir);
      if (selected.has("cache")) await rm(paths.cache, { recursive: true, force: true });
      const after = await inspect();
      return {
        dry_run: false,
        reclaimable_bytes: reclaimableBytes,
        removed_bytes: Math.max(0, before.total_bytes - after.total_bytes),
        before,
        after,
      };
    },
  };
}
