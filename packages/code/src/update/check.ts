import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { globalPaths, writeFileAtomic } from "@clarvis/paths";
import {
  RELEASE_REPOSITORY,
  compareProductVersions,
  parseProductVersion,
  releaseTarget,
  selectUpdateRelease,
  type ReleaseTarget,
  type UpdateSelection,
} from "../update-contract.ts";
import { fetchReleaseIndex, type ReleaseFetch } from "./github-releases.ts";
import { managedInstallation } from "./installation.ts";

const UPDATE_CHECK_CACHE_SCHEMA = 1;
const UPDATE_CHECK_CACHE_MAX_BYTES = 16 * 1024;
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 5_000;

interface UpdateCheckCache {
  schema: 1;
  repository: typeof RELEASE_REPOSITORY;
  checked_at: number;
  current_version: string;
  target: ReleaseTarget;
  etag?: string;
  available?: { version: string; tag_name: string };
}

export type UpdateCheckResult =
  | { kind: "available"; version: string; tagName: string; source: "cache" | "network" }
  | { kind: "current"; source: "cache" | "network" }
  | { kind: "skipped"; reason: "source" | "unmanaged" | "unsupported" }
  | { kind: "failed"; reason: string };

/** Injectable edges for the passive, non-mutating update check. */
export interface UpdateCheckOptions {
  currentVersion: string;
  environment?: NodeJS.ProcessEnv;
  fetch?: ReleaseFetch;
  platform?: NodeJS.Platform;
  architecture?: string;
  apiUrl?: string;
  cacheFile?: string;
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cacheAvailable(
  value: unknown,
  currentVersion: string,
): UpdateCheckCache["available"] | undefined | null {
  if (value === undefined) return undefined;
  const candidate = object(value);
  if (
    candidate === undefined ||
    typeof candidate.version !== "string" ||
    typeof candidate.tag_name !== "string" ||
    candidate.tag_name !== `v${candidate.version}` ||
    parseProductVersion(candidate.version) === undefined ||
    compareProductVersions(candidate.version, currentVersion) <= 0
  ) {
    return null;
  }
  const current = parseProductVersion(currentVersion);
  const next = parseProductVersion(candidate.version);
  if (current === undefined || next === undefined) return null;
  if (current.prerelease.length === 0 && next.prerelease.length > 0) return null;
  return { version: candidate.version, tag_name: candidate.tag_name };
}

function parseCache(
  value: unknown,
  currentVersion: string,
  target: ReleaseTarget,
): UpdateCheckCache | undefined {
  const input = object(value);
  if (
    input === undefined ||
    input.schema !== UPDATE_CHECK_CACHE_SCHEMA ||
    input.repository !== RELEASE_REPOSITORY ||
    input.current_version !== currentVersion ||
    input.target !== target ||
    typeof input.checked_at !== "number" ||
    !Number.isFinite(input.checked_at) ||
    (input.etag !== undefined &&
      (typeof input.etag !== "string" ||
        input.etag.length > 256 ||
        !/^[\x21-\x7e]+$/.test(input.etag)))
  ) {
    return undefined;
  }
  const available = cacheAvailable(input.available, currentVersion);
  if (available === null) return undefined;
  return {
    schema: 1,
    repository: RELEASE_REPOSITORY,
    checked_at: input.checked_at,
    current_version: currentVersion,
    target,
    ...(typeof input.etag === "string" ? { etag: input.etag } : {}),
    ...(available === undefined ? {} : { available }),
  };
}

async function readCache(
  file: string,
  currentVersion: string,
  target: ReleaseTarget,
): Promise<UpdateCheckCache | undefined> {
  try {
    const bytes = await readFile(file);
    if (bytes.byteLength > UPDATE_CHECK_CACHE_MAX_BYTES) return undefined;
    return parseCache(JSON.parse(new TextDecoder().decode(bytes)), currentVersion, target);
  } catch {
    return undefined;
  }
}

function resultFromCache(cache: UpdateCheckCache, source: "cache" | "network"): UpdateCheckResult {
  return cache.available === undefined
    ? { kind: "current", source }
    : {
        kind: "available",
        version: cache.available.version,
        tagName: cache.available.tag_name,
        source,
      };
}

function cacheFromSelection(
  currentVersion: string,
  target: ReleaseTarget,
  checkedAt: number,
  selection: UpdateSelection | undefined,
  etag: string | undefined,
): UpdateCheckCache {
  return {
    schema: 1,
    repository: RELEASE_REPOSITORY,
    checked_at: checkedAt,
    current_version: currentVersion,
    target,
    ...(etag === undefined ? {} : { etag }),
    ...(selection === undefined
      ? {}
      : { available: { version: selection.version, tag_name: selection.tagName } }),
  };
}

async function persistCache(file: string, cache: UpdateCheckCache): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(cache) + "\n").catch(() => undefined);
}

async function runUpdateCheck(options: UpdateCheckOptions): Promise<UpdateCheckResult> {
  const environment = options.environment ?? process.env;
  if (environment.CLARVIS_CODE_SOURCE === "1") return { kind: "skipped", reason: "source" };
  if (
    environment.CLARVIS_INSTALL_ROOT === undefined ||
    !isAbsolute(environment.CLARVIS_INSTALL_ROOT)
  ) {
    return { kind: "skipped", reason: "unmanaged" };
  }
  const target = releaseTarget(options.platform, options.architecture);
  if (target === undefined) return { kind: "skipped", reason: "unsupported" };
  try {
    await managedInstallation(environment, options.currentVersion, target);
    const cacheFile = options.cacheFile ?? globalPaths().updateCheckCacheFile;
    const now = options.now ?? Date.now;
    const cache = await readCache(cacheFile, options.currentVersion, target);
    const checkedAt = now();
    const age = cache === undefined ? -1 : checkedAt - cache.checked_at;
    if (cache !== undefined && age >= 0 && age < UPDATE_CHECK_TTL_MS) {
      return resultFromCache(cache, "cache");
    }
    const response = await fetchReleaseIndex(
      options.fetch ?? globalThis.fetch,
      `clarvis/${options.currentVersion}`,
      {
        ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
        ...(cache?.etag === undefined ? {} : { etag: cache.etag }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS,
      },
    );
    if (response.kind === "not-modified") {
      if (cache === undefined) return { kind: "failed", reason: "not_modified_without_cache" };
      const refreshed = { ...cache, checked_at: checkedAt };
      await persistCache(cacheFile, refreshed);
      return resultFromCache(refreshed, "network");
    }
    const selection = selectUpdateRelease(options.currentVersion, target, response.records);
    const next = cacheFromSelection(
      options.currentVersion,
      target,
      checkedAt,
      selection,
      response.etag,
    );
    await persistCache(cacheFile, next);
    return resultFromCache(next, "network");
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Build a once-per-process passive update checker. */
export function createUpdateChecker(): (options: UpdateCheckOptions) => Promise<UpdateCheckResult> {
  let result: Promise<UpdateCheckResult> | undefined;
  return (options) => (result ??= runUpdateCheck(options));
}

/** Check once whether this managed Clarvis installation has an eligible newer release. */
export const checkForUpdate = createUpdateChecker();
