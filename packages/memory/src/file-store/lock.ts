import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import { levelEnabled, NOOP_LOGGER, type Logger } from "@clarvis/capability";
import { bestEffortFileStore, detachFileStoreTask } from "./tasks.ts";
import { readUtf8FileBounded } from "../bounded-io.ts";
import { MEMORY_STORAGE_LIMITS } from "../storage-limits.ts";

export interface TreeLockOptions {
  lockDir: string;
  staleMs: number;
  heartbeatMs: number;
  timeoutMs: number;
  init: () => Promise<void>;
  /**
   * How long a hold may last before the release path reports it.
   *
   * @remarks Defaults to {@link DEFAULT_LOCK_WARN_MS}; the host resolves
   * `CLARVIS_MEMORY_LOCK_WARN_MS` and passes it down.
   */
  warnMs?: number;
  logger?: Logger;
}

/**
 * How long a hold has to last before it is reported.
 *
 * @remarks The rule this enforces is "never start an index pass from inside
 * `store.exclusive`". The store's lock is re-entrant, so breaking that rule
 * does not deadlock — the pass's tool calls join the outer handle and the tree
 * stays locked for a whole inference, which no test and no type can see. Any
 * legitimate hold is a bounded batch of file writes; five seconds separates the
 * two without reporting a slow disk.
 */
export const DEFAULT_LOCK_WARN_MS = 5_000;

/**
 * The release a re-entrant hold performs: none.
 *
 * @remarks A hold taken inside an existing one must not acquire the directory
 * lock — `mkdir` would fail `EEXIST` against the caller's own hold and the wait
 * would run to its timeout — and must not release it either, or the outer hold
 * would continue over an unlocked tree. `MemoryStore.exclusive` guards nesting
 * before it ever reaches here; this makes the lock itself honest about it, and
 * is what lets `memory.lock.held_long` say which of the two a long hold was.
 */
const NO_RELEASE = (): Promise<void> => Promise.resolve();

export interface TreeLock {
  nested: () => boolean;
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createTreeLock(options: TreeLockOptions): TreeLock {
  const holderFile = `${options.lockDir}/holder`;
  const context = new AsyncLocalStorage<true>();
  const logger = options.logger ?? NOOP_LOGGER;
  const warnMs = options.warnMs ?? DEFAULT_LOCK_WARN_MS;

  async function readHolder(): Promise<string | null> {
    const result = await readUtf8FileBounded(holderFile, {
      maxBytes: MEMORY_STORAGE_LIMITS.prefixBytes,
      kind: "metadata",
      truncate: true,
    });
    return result === null || result.truncated ? null : result.text;
  }

  async function holderAlive(): Promise<boolean> {
    const token = await readHolder();
    if (token === null) return false;
    const pid = Number.parseInt(token.split(".")[0] ?? "", 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  async function stealable(): Promise<boolean> {
    try {
      const held = await fs.stat(options.lockDir);
      if (Date.now() - held.mtimeMs <= options.staleMs) return false;
      if (await holderAlive()) return false;
      const again = await fs.stat(options.lockDir);
      return Date.now() - again.mtimeMs > options.staleMs;
    } catch {
      return false;
    }
  }

  async function acquire(): Promise<() => Promise<void>> {
    await options.init();
    const token = `${process.pid}.${Math.random().toString(36).slice(2)}`;
    const startedAt = Date.now();
    const deadline = startedAt + options.timeoutMs;
    let stolen = false;
    let waited = false;
    for (;;) {
      try {
        await fs.mkdir(options.lockDir, { mode: 0o700 });
        try {
          await fs.writeFile(holderFile, token, { encoding: "utf8", mode: 0o600 });
        } catch (error) {
          await bestEffortFileStore(
            "memory_failed_lock_cleanup",
            () => fs.rm(options.lockDir, { recursive: true, force: true }),
            logger,
          );
          throw error;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        waited = true;
        if (await stealable()) {
          stolen = true;
          await bestEffortFileStore(
            "memory_stale_lock_cleanup",
            () => fs.rm(options.lockDir, { recursive: true, force: true }),
            logger,
          );
        }
        if (Date.now() > deadline) {
          throw new Error(`memory: timed out waiting for tree lock ${options.lockDir}`, {
            cause: error,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (waited && levelEnabled(logger, "debug")) {
      logger.debug(
        { event: "memory.lock.wait", waited_ms: Date.now() - startedAt, stolen },
        "the memory tree lock was held by someone else; this caller queued for it",
      );
    }
    const heartbeat = setInterval(() => {
      const now = new Date();
      detachFileStoreTask(
        "memory_lock_heartbeat",
        () => fs.utimes(options.lockDir, now, now),
        logger,
      );
    }, options.heartbeatMs);
    heartbeat.unref?.();
    return async () => {
      clearInterval(heartbeat);
      if ((await readHolder()) === token) {
        await bestEffortFileStore(
          "memory_lock_release",
          () => fs.rm(options.lockDir, { recursive: true, force: true }),
          logger,
        );
      }
    };
  }

  return {
    nested: () => context.getStore() === true,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const nested = context.getStore() === true;
      const release = nested ? NO_RELEASE : await acquire();
      const heldFrom = Date.now();
      try {
        return await context.run(true, fn);
      } finally {
        const heldMs = Date.now() - heldFrom;
        if (heldMs > warnMs) {
          logger.warn(
            {
              event: "memory.lock.held_long",
              lock_dir: options.lockDir,
              held_ms: heldMs,
              nested,
              threshold_ms: warnMs,
            },
            "the memory tree lock was held far longer than a batch of writes takes; the wiki tools, the memory panel and every concurrent run's seed were blocked for that whole time",
          );
        }
        await release();
      }
    },
  };
}
