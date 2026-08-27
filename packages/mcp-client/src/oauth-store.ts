import { constants } from "node:fs";
import { chmod, mkdir, open, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { acquireLocalLease, DIR_MODE, FILE_MODE, writeFileDurable } from "@clarvis/paths";

/** Maximum private credential document accepted before parsing. */
export const MAX_MCP_OAUTH_STORE_BYTES = 1024 * 1024;
/** Maximum independently authorized remote MCP identities retained. */
export const MAX_MCP_OAUTH_RECORDS = 128;
const MAX_RECORD_BYTES = 512 * 1024;
const RECORD_KEY = /^[a-f0-9]{64}$/;
const CALLBACK_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/oauth\/callback$/;

/** Persisted credentials for one owner and remote MCP resource. */
export interface McpOAuthRecord {
  redirect_url?: string;
  client_information?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  updated_at: number;
}

interface McpOAuthFileV1 {
  version: 1;
  records: Record<string, McpOAuthRecord>;
}

/** A credential document was unsafe, corrupt, oversized, or unavailable. */
export class McpOAuthStoreError extends Error {
  readonly code = "mcp_oauth_store_invalid" as const;

  constructor(readonly diagnostic: "malformed" | "oversized" | "unsafe_path" | "unreadable") {
    super(`MCP OAuth credential store is ${diagnostic}; repair it manually.`);
    this.name = "McpOAuthStoreError";
  }
}

/** Durable credential operations needed by one OAuth provider. */
export interface McpOAuthCredentialStore {
  path(): string;
  readRecord(key: string): Promise<McpOAuthRecord | undefined>;
  mutateRecord(
    key: string,
    mutate: (current: McpOAuthRecord | undefined) => McpOAuthRecord | undefined,
  ): Promise<void>;
}

function emptyFile(): McpOAuthFileV1 {
  return { version: 1, records: {} };
}

function validRedirect(value: unknown): value is string {
  if (typeof value !== "string" || !CALLBACK_URL.test(value)) return false;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return port >= 1 && port <= 65_535;
  } catch {
    return false;
  }
}

function parseRecord(value: unknown): McpOAuthRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const known = new Set(["redirect_url", "client_information", "tokens", "updated_at"]);
  if (Object.keys(source).some((key) => !known.has(key))) return undefined;
  if (!Number.isSafeInteger(source.updated_at) || Number(source.updated_at) < 0) return undefined;
  if (source.redirect_url !== undefined && !validRedirect(source.redirect_url)) return undefined;

  let clientInformation: OAuthClientInformationMixed | undefined;
  if (source.client_information !== undefined) {
    const full = OAuthClientInformationFullSchema.safeParse(source.client_information);
    const basic = full.success
      ? undefined
      : OAuthClientInformationSchema.safeParse(source.client_information);
    if (!full.success && !basic?.success) return undefined;
    clientInformation = full.success ? full.data : basic!.data;
  }

  let tokens: OAuthTokens | undefined;
  if (source.tokens !== undefined) {
    const parsed = OAuthTokensSchema.safeParse(source.tokens);
    if (!parsed.success) return undefined;
    tokens = parsed.data;
  }

  const record: McpOAuthRecord = {
    updated_at: Number(source.updated_at),
    ...(source.redirect_url === undefined ? {} : { redirect_url: source.redirect_url }),
    ...(clientInformation === undefined ? {} : { client_information: clientInformation }),
    ...(tokens === undefined ? {} : { tokens }),
  };
  return Buffer.byteLength(JSON.stringify(record), "utf8") <= MAX_RECORD_BYTES ? record : undefined;
}

function parseFile(value: unknown): McpOAuthFileV1 | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (
    source.version !== 1 ||
    typeof source.records !== "object" ||
    source.records === null ||
    Array.isArray(source.records) ||
    Object.keys(source).some((key) => key !== "version" && key !== "records")
  ) {
    return undefined;
  }
  const entries = Object.entries(source.records as Record<string, unknown>);
  if (entries.length > MAX_MCP_OAUTH_RECORDS) return undefined;
  const records: Record<string, McpOAuthRecord> = {};
  for (const [key, raw] of entries) {
    if (!RECORD_KEY.test(key)) return undefined;
    const record = parseRecord(raw);
    if (record === undefined) return undefined;
    records[key] = record;
  }
  return { version: 1, records };
}

function diagnosticFor(error: unknown): McpOAuthStoreError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return new McpOAuthStoreError(
    code === "ELOOP" || code === "ENOTDIR" ? "unsafe_path" : "unreadable",
  );
}

async function readValidated(file: string): Promise<McpOAuthFileV1> {
  const parent = resolve(dirname(file));
  try {
    const [resolved, info] = await Promise.all([realpath(parent), stat(parent)]);
    if (!info.isDirectory() || resolved !== parent) {
      throw new McpOAuthStoreError("unsafe_path");
    }
  } catch (error) {
    if (error instanceof McpOAuthStoreError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
    throw diagnosticFor(error);
  }

  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
    throw diagnosticFor(error);
  }

  let buffer: Buffer | undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new McpOAuthStoreError("unsafe_path");
    if (info.size > MAX_MCP_OAUTH_STORE_BYTES) throw new McpOAuthStoreError("oversized");
    buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > MAX_MCP_OAUTH_STORE_BYTES) throw new McpOAuthStoreError("oversized");
    let decoded: unknown;
    try {
      decoded = JSON.parse(buffer.subarray(0, offset).toString("utf8"));
    } catch {
      throw new McpOAuthStoreError("malformed");
    }
    const parsed = parseFile(decoded);
    if (parsed === undefined) throw new McpOAuthStoreError("malformed");
    return parsed;
  } catch (error) {
    if (error instanceof McpOAuthStoreError) throw error;
    throw diagnosticFor(error);
  } finally {
    buffer?.fill(0);
    try {
      await handle.close();
    } catch {}
  }
}

async function ensureSafeParent(file: string): Promise<void> {
  const parent = resolve(dirname(file));
  await mkdir(parent, { recursive: true, mode: DIR_MODE });
  if (process.platform !== "win32") await chmod(parent, DIR_MODE);
  const [resolved, info] = await Promise.all([realpath(parent), stat(parent)]);
  if (!info.isDirectory() || resolved !== parent) {
    throw new McpOAuthStoreError("unsafe_path");
  }
}

/** Build the private, process-coordinated OAuth credential store at `file`. */
export function createMcpOAuthCredentialStore(
  file: string,
  options: { lockWaitMs?: number } = {},
): McpOAuthCredentialStore {
  const lock = `${file}.lock`;
  return {
    path: () => file,
    async readRecord(key: string): Promise<McpOAuthRecord | undefined> {
      if (!RECORD_KEY.test(key)) throw new Error("invalid MCP OAuth record key");
      return (await readValidated(file)).records[key];
    },
    async mutateRecord(key, mutate): Promise<void> {
      if (!RECORD_KEY.test(key)) throw new Error("invalid MCP OAuth record key");
      await ensureSafeParent(file);
      const lease = await acquireLocalLease(lock, {
        staleMs: 30_000,
        waitMs: options.lockWaitMs ?? 2_000,
        retryMs: 25,
        heartbeatMs: 5_000,
      });
      if (lease === null) throw new Error("MCP OAuth credentials are in use by another process.");
      try {
        const snapshot = await readValidated(file);
        const next = mutate(snapshot.records[key]);
        const records = { ...snapshot.records };
        if (next === undefined) delete records[key];
        else {
          const parsed = parseRecord(next);
          if (parsed === undefined) throw new Error("invalid MCP OAuth credential record");
          records[key] = parsed;
        }
        const ordered = Object.entries(records).sort(
          (left, right) => right[1].updated_at - left[1].updated_at,
        );
        const bounded = Object.fromEntries(ordered.slice(0, MAX_MCP_OAUTH_RECORDS));
        const serialized = `${JSON.stringify({ version: 1, records: bounded }, null, 2)}\n`;
        if (Buffer.byteLength(serialized) > MAX_MCP_OAUTH_STORE_BYTES) {
          throw new McpOAuthStoreError("oversized");
        }
        await lease.assertOwned();
        await writeFileDurable(file, serialized, { mode: FILE_MODE, dirMode: DIR_MODE });
        if (process.platform !== "win32") await chmod(file, FILE_MODE);
      } finally {
        await lease.release();
      }
    },
  };
}
