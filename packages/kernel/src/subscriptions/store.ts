import { constants } from "node:fs";
import { chmod, mkdir, open, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";

import {
  acquireLocalLease,
  DIR_MODE,
  FILE_MODE,
  globalPaths,
  writeFileDurable,
} from "@clarvis/paths";
import type { SubscriptionScheme } from "@clarvis/protocol";
import { z } from "zod";

import type { SubscriptionAccountRecord, SubscriptionFileV1 } from "./types.ts";
import { SubscriptionError } from "./redaction.ts";

const MAX_SUBSCRIPTIONS_FILE_BYTES = 1024 * 1024;
const TOKEN_MAX_CHARS = 256 * 1024;

const accountSchema = z
  .object({
    access_token: z.string().min(1).max(TOKEN_MAX_CHARS),
    refresh_token: z.string().min(1).max(TOKEN_MAX_CHARS),
    expires_at: z.number().int().nonnegative(),
    account_id: z.string().min(1).max(4096).optional(),
    account_label: z.string().min(1).max(256).optional(),
    plan: z.string().min(1).max(128).optional(),
  })
  .strict();

const subscriptionFileSchema = z
  .object({
    version: z.literal(1),
    accounts: z
      .object({
        "openai-codex": accountSchema.optional(),
        "xai-grok": accountSchema.optional(),
      })
      .strict(),
  })
  .strict();

/** Read outcome that never substitutes an invalid credential document with an empty valid one. */
export type SubscriptionStoreSnapshot =
  | { ok: true; value: SubscriptionFileV1 }
  | { ok: false; diagnostic: "malformed" | "oversized" | "unsafe_path" | "unreadable" };

/** Mutation callback result. `undefined` deletes only the selected account. */
export interface SubscriptionAccountMutation<T> {
  account: SubscriptionAccountRecord | undefined;
  result: T;
}

/** Durable, process-coordinated storage for renewable subscription credentials. */
export interface SubscriptionStore {
  path(): string;
  read(): Promise<SubscriptionStoreSnapshot>;
  mutateAccount<T>(
    scheme: SubscriptionScheme,
    mutate: (
      current: SubscriptionAccountRecord | undefined,
    ) => Promise<SubscriptionAccountMutation<T>> | SubscriptionAccountMutation<T>,
  ): Promise<T>;
}

export interface FileSubscriptionStoreOptions {
  dir?: string;
  lockWaitMs?: number;
}

function emptyFile(): SubscriptionFileV1 {
  return { version: 1, accounts: {} };
}

function diagnosticFor(error: unknown): SubscriptionStoreSnapshot {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") return { ok: false, diagnostic: "unsafe_path" };
  }
  return { ok: false, diagnostic: "unreadable" };
}

async function readValidated(file: string): Promise<SubscriptionStoreSnapshot> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: emptyFile() };
    return diagnosticFor(error);
  }

  let buffer: Buffer | undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, diagnostic: "unsafe_path" };
    if (info.size > MAX_SUBSCRIPTIONS_FILE_BYTES) return { ok: false, diagnostic: "oversized" };
    buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > MAX_SUBSCRIPTIONS_FILE_BYTES) return { ok: false, diagnostic: "oversized" };
    let decoded: unknown;
    try {
      decoded = JSON.parse(buffer.subarray(0, offset).toString("utf8"));
    } catch {
      return { ok: false, diagnostic: "malformed" };
    }
    const parsed = subscriptionFileSchema.safeParse(decoded);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, diagnostic: "malformed" };
  } catch (error) {
    return diagnosticFor(error);
  } finally {
    buffer?.fill(0);
    try {
      await handle.close();
    } catch {}
  }
}

async function ensureSafeParent(file: string): Promise<void> {
  const parent = dirname(file);
  await mkdir(parent, { recursive: true, mode: DIR_MODE });
  if (process.platform !== "win32") await chmod(parent, DIR_MODE);
  const [resolved, info] = await Promise.all([realpath(parent), stat(parent)]);
  if (!info.isDirectory() || resolved !== parent) {
    throw new Error("subscription credential directory is not a resolved directory");
  }
}

/** Build the global `subscriptions.json` store without importing it into settings snapshots. */
export function createFileSubscriptionStore(
  options: FileSubscriptionStoreOptions = {},
): SubscriptionStore {
  const file = globalPaths(options.dir).subscriptionsFile;
  const lock = `${file}.lock`;

  return {
    path: () => file,
    read: () => readValidated(file),
    async mutateAccount<T>(
      scheme: SubscriptionScheme,
      mutate: (
        current: SubscriptionAccountRecord | undefined,
      ) => Promise<SubscriptionAccountMutation<T>> | SubscriptionAccountMutation<T>,
    ): Promise<T> {
      await ensureSafeParent(file);
      const lease = await acquireLocalLease(lock, {
        staleMs: 30_000,
        waitMs: options.lockWaitMs ?? 2_000,
        retryMs: 25,
        heartbeatMs: 5_000,
      });
      if (lease === null) {
        throw new SubscriptionError(
          "subscription_in_use",
          "Subscription credentials are in use by another Clarvis process.",
        );
      }
      try {
        const snapshot = await readValidated(file);
        if (!snapshot.ok) {
          throw new Error(
            `subscription credential store is ${snapshot.diagnostic}; repair it manually`,
          );
        }
        const next = await mutate(snapshot.value.accounts[scheme]);
        await lease.assertOwned();
        const accounts = { ...snapshot.value.accounts };
        if (next.account === undefined) delete accounts[scheme];
        else accounts[scheme] = next.account;
        const serialized = `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`;
        await writeFileDurable(file, serialized, { mode: FILE_MODE, dirMode: DIR_MODE });
        if (process.platform !== "win32") await chmod(file, FILE_MODE);
        return next.result;
      } finally {
        await lease.release();
      }
    },
  };
}
