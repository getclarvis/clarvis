import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { bestEffortFileStore } from "./tasks.ts";
import * as path from "node:path";

import { createSampler, NOOP_LOGGER, type Logger } from "@clarvis/capability";
import { writeFileDurable } from "@clarvis/paths";

import { readUtf8FileBounded, scanDirectoryBounded } from "../bounded-io.ts";
import {
  appendAttempt,
  DEFAULT_MEMORY_JOB_PAGE_SIZE,
  isJobPrunable,
  keptFailureIds,
  MAX_JOB_HISTORY,
  type MemoryIndexJob,
  type MemoryJobState,
} from "../jobs.ts";
import {
  assertMemoryPayloadBytes,
  MEMORY_STORAGE_LIMITS,
  MemoryStorageLimitError,
} from "../storage-limits.ts";
import type { MemoryJobReader, MemoryJobTx } from "../types.ts";

const JOB_STATES = new Set<MemoryJobState>([
  "pending",
  "running",
  "retry_wait",
  "completed",
  "failed",
]);

function parseJob(raw: string, expectedRunId?: string): MemoryIndexJob | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const job = value as Partial<MemoryIndexJob>;
    if (
      typeof job.run_id !== "string" ||
      (expectedRunId !== undefined && job.run_id !== expectedRunId) ||
      !JOB_STATES.has(job.state as MemoryJobState) ||
      typeof job.enqueued_at !== "number" ||
      typeof job.updated_at !== "number" ||
      typeof job.attempts !== "number" ||
      !Array.isArray(job.history) ||
      job.history.length > MAX_JOB_HISTORY
    ) {
      return null;
    }
    return job as MemoryIndexJob;
  } catch {
    return null;
  }
}

export interface JobRepository {
  reader: MemoryJobReader;
  tx: MemoryJobTx;
  wasIndexed(runId: string): Promise<boolean>;
  markIndexed(runId: string, at: number): Promise<void>;
}

export function encodeRunId(runId: string): string {
  const slug = runId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
  return `${slug}-${createHash("sha256").update(runId).digest("hex").slice(0, 12)}`;
}

export function createJobRepository(options: {
  machineryRoot: string;
  init: () => Promise<void>;
  logger?: Logger;
}): JobRepository {
  const logger = options.logger ?? NOOP_LOGGER;
  /**
   * Admits the first eight corrupt records of one shape, then powers of two.
   *
   * @remarks A whole queue directory can be corrupt at once — the scan visits up
   * to {@link MEMORY_STORAGE_LIMITS.scanEntries} files — and a line per file
   * would make the report the incident. Keyed by reason so the first records of
   * each shape are named individually.
   */
  const corruptSample = createSampler();
  /**
   * Report a queued job record the scan could not use.
   *
   * @param file - the record's basename; run ids are encoded into it, and the
   *   snapshot the record carries is never read here.
   * @param reason - which check rejected it.
   * @remarks Without this a run's learning simply disappears: the record is
   *   skipped, no counter moves, and the job never becomes due again.
   */
  const reportCorrupt = (file: string, reason: string): void => {
    if (!corruptSample(reason)) return;
    logger.warn(
      { event: "memory.job.record_corrupt", file, reason },
      "a queued index job could not be read back; that run's learning is lost and nothing will retry it",
    );
  };
  const jobsDir = path.join(options.machineryRoot, ".state", "jobs");
  const indexedDir = path.join(options.machineryRoot, ".state", "indexed");
  const jobPath = (runId: string): string => path.join(jobsDir, `${encodeRunId(runId)}.json`);
  const indexedMarker = (runId: string): string => path.join(indexedDir, encodeRunId(runId));

  async function readJob(runId: string): Promise<MemoryIndexJob | null> {
    await options.init();
    const raw = await readJobText(jobPath(runId), true);
    if (raw === null) return null;
    const job = parseJob(raw.text, runId);
    if (job === null) reportCorrupt(`${encodeRunId(runId)}.json`, "unreadable_record");
    return job;
  }

  async function writeJob(job: MemoryIndexJob): Promise<void> {
    const serialized = JSON.stringify(job);
    assertMemoryPayloadBytes(
      "metadata",
      `job:${job.run_id}`,
      serialized,
      MEMORY_STORAGE_LIMITS.metadataBytes,
    );
    await writeFileDurable(jobPath(job.run_id), serialized);
  }

  async function readJobText(file: string, strict = false) {
    try {
      const result = await readUtf8FileBounded(file, {
        maxBytes: MEMORY_STORAGE_LIMITS.metadataBytes,
        kind: "metadata",
        truncate: !strict,
      });
      return result === null || result.truncated ? null : result;
    } catch (error) {
      if (strict || error instanceof MemoryStorageLimitError) throw error;
      return null;
    }
  }

  async function scanJobs(visit: (job: MemoryIndexJob) => void | Promise<void>): Promise<void> {
    await options.init();
    let corpusBytes = 0;
    await scanDirectoryBounded(jobsDir, MEMORY_STORAGE_LIMITS.scanEntries, async (entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return;
      const raw = await readJobText(path.join(jobsDir, entry.name));
      if (raw === null) return;
      if (corpusBytes + raw.bytes > MEMORY_STORAGE_LIMITS.corpusBytes) return false;
      corpusBytes += raw.bytes;
      const job = parseJob(raw.text);
      if (job === null) {
        reportCorrupt(entry.name, "unreadable_record");
        return;
      }
      if (entry.name !== `${encodeRunId(job.run_id)}.json`) {
        reportCorrupt(entry.name, "run_id_mismatch");
        return;
      }
      await visit(job);
    });
  }

  const reader: MemoryJobReader = {
    get: readJob,
    async list(query = {}) {
      const wanted =
        query.state === undefined
          ? null
          : new Set<MemoryJobState>(
              typeof query.state === "string" ? [query.state] : [...query.state],
            );
      const limit = Math.min(
        DEFAULT_MEMORY_JOB_PAGE_SIZE,
        Math.max(1, query.limit ?? DEFAULT_MEMORY_JOB_PAGE_SIZE),
      );
      const page: MemoryIndexJob[] = [];
      await scanJobs((job) => {
        if (wanted !== null && !wanted.has(job.state)) return;
        page.push(job);
        page.sort((a, b) => b.enqueued_at - a.enqueued_at);
        if (page.length > limit) page.pop();
      });
      return page;
    },
    async counts() {
      const counts: Record<MemoryJobState, number> = {
        pending: 0,
        running: 0,
        retry_wait: 0,
        completed: 0,
        failed: 0,
      };
      await scanJobs((job) => {
        counts[job.state] += 1;
      });
      return counts;
    },
    async nextDueAt() {
      let earliest: number | undefined;
      await scanJobs((job) => {
        const due =
          job.state === "pending"
            ? job.enqueued_at
            : job.state === "retry_wait"
              ? job.not_before
              : job.state === "running"
                ? job.lease_until
                : undefined;
        if (due !== undefined && (earliest === undefined || due < earliest)) earliest = due;
      });
      return earliest;
    },
  };

  const tx: MemoryJobTx = {
    ...reader,
    async enqueue(input) {
      const existing = await readJob(input.run_id);
      if (existing !== null) return existing;
      const job: MemoryIndexJob = {
        run_id: input.run_id,
        state: "pending",
        enqueued_at: input.at,
        updated_at: input.at,
        attempts: 0,
        snapshot: input.snapshot,
        ...(input.provider_key !== undefined ? { provider_key: input.provider_key } : {}),
        history: [],
      };
      await writeJob(job);
      return job;
    },
    async claim(now, lease) {
      let next: MemoryIndexJob | undefined;
      await scanJobs((job) => {
        const due =
          job.state === "pending" ||
          (job.state === "retry_wait" && (job.not_before ?? 0) <= now) ||
          (job.state === "running" && (job.lease_until ?? 0) <= now);
        if (due && (next === undefined || job.enqueued_at < next.enqueued_at)) next = job;
      });
      if (next === undefined) return null;
      const claimed: MemoryIndexJob = {
        ...next,
        state: "running",
        attempts: next.attempts + 1,
        updated_at: now,
        lease_until: now + lease.ms,
        lease_owner: lease.owner,
        lease_token: lease.token ?? randomUUID(),
      };
      delete claimed.not_before;
      await writeJob(claimed);
      return claimed;
    },
    async renew(runId, at, lease, ms) {
      const job = await readJob(runId);
      if (
        job === null ||
        job.state !== "running" ||
        job.lease_owner !== lease.owner ||
        job.lease_token !== lease.token ||
        (job.lease_until ?? 0) <= at
      ) {
        return false;
      }
      await writeJob({ ...job, updated_at: at, lease_until: at + ms });
      return true;
    },
    async refreshOwnedAfterFence(runId, at, lease, ms) {
      const job = await readJob(runId);
      if (
        job === null ||
        job.state !== "running" ||
        job.lease_owner !== lease.owner ||
        job.lease_token !== lease.token
      ) {
        return false;
      }
      await writeJob({ ...job, updated_at: at, lease_until: at + ms });
      return true;
    },
    async complete(runId, at, note, lease) {
      const job = await readJob(runId);
      if (job === null) return false;
      if (
        (job.state === "running" || lease !== undefined) &&
        (lease === undefined ||
          job.state !== "running" ||
          job.lease_owner !== lease.owner ||
          job.lease_token !== lease.token ||
          (job.lease_until ?? 0) <= at)
      ) {
        return false;
      }
      const done: MemoryIndexJob = {
        ...job,
        state: "completed",
        updated_at: at,
        ...(note !== undefined ? { note } : {}),
      };
      delete done.snapshot;
      delete done.lease_until;
      delete done.lease_owner;
      delete done.lease_token;
      delete done.not_before;
      await writeJob(done);
      return true;
    },
    async fail(runId, at, failure, next, lease) {
      const job = await readJob(runId);
      if (job === null) return false;
      if (
        (job.state === "running" || lease !== undefined) &&
        (lease === undefined ||
          job.state !== "running" ||
          job.lease_owner !== lease.owner ||
          job.lease_token !== lease.token ||
          (job.lease_until ?? 0) <= at)
      ) {
        return false;
      }
      const updated: MemoryIndexJob = {
        ...job,
        state: next.state,
        updated_at: at,
        history: appendAttempt(job, failure, at),
        note: `${failure.phase}: ${failure.error}`.slice(0, 200),
      };
      delete updated.lease_until;
      delete updated.lease_owner;
      delete updated.lease_token;
      if (next.state === "retry_wait") updated.not_before = next.not_before;
      else delete updated.not_before;
      await writeJob(updated);
      return true;
    },
    async release(runId, at, note, lease) {
      const job = await readJob(runId);
      if (job === null) return false;
      if (
        (job.state === "running" || lease !== undefined) &&
        (lease === undefined ||
          job.state !== "running" ||
          job.lease_owner !== lease.owner ||
          job.lease_token !== lease.token ||
          (job.lease_until ?? 0) <= at)
      ) {
        return false;
      }
      const released: MemoryIndexJob = {
        ...job,
        state: "pending",
        attempts: Math.max(0, job.attempts - 1),
        updated_at: at,
        ...(note !== undefined ? { note } : {}),
      };
      delete released.lease_until;
      delete released.lease_owner;
      delete released.lease_token;
      delete released.not_before;
      await writeJob(released);
      return true;
    },
    async retry(runId, at) {
      const job = await readJob(runId);
      if (job === null || job.state !== "failed") return null;
      const revived: MemoryIndexJob = {
        ...job,
        state: "pending",
        attempts: 0,
        updated_at: at,
        note: "retried by operator",
      };
      delete revived.not_before;
      delete revived.lease_until;
      delete revived.lease_owner;
      delete revived.lease_token;
      await writeJob(revived);
      return revived;
    },
    async prune(pruneOptions) {
      const failures: MemoryIndexJob[] = [];
      await scanJobs((job) => {
        if (job.state !== "failed") return;
        failures.push(job);
        failures.sort((a, b) => b.updated_at - a.updated_at);
        if (failures.length > pruneOptions.keepFailed) failures.pop();
      });
      const keep = keptFailureIds(failures, pruneOptions.keepFailed);
      let removed = 0;
      await scanJobs(async (job) => {
        if (keep.has(job.run_id) || !isJobPrunable(job, pruneOptions)) return;
        await bestEffortFileStore("memory_job_prune", () =>
          fs.rm(jobPath(job.run_id), { force: true }),
        );
        removed += 1;
      });
      return removed;
    },
  };

  return {
    reader,
    tx,
    async wasIndexed(runId) {
      await options.init();
      try {
        return (await fs.stat(indexedMarker(runId))).isFile();
      } catch {
        return false;
      }
    },
    async markIndexed(runId, at) {
      await options.init();
      await writeFileDurable(indexedMarker(runId), String(at));
    },
  };
}
