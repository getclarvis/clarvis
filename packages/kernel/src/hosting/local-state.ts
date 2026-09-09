import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { bestEffort, NOOP_LOGGER, type Logger } from "@clarvis/capability";
import {
  acquireLocalLease,
  DIR_MODE,
  FILE_MODE,
  globalPaths,
  localHostPaths,
  ownerFromWorkspace,
  writeFileDurable,
  type LocalHostPaths,
  type LocalLease,
} from "@clarvis/paths";
import { kernelError } from "../core/errors.ts";
import { CLARVIS_WIRE_VERSION } from "../transport/wire.ts";
import { openHostedProjection } from "./projection.ts";
import { decodeHostedRegistryState, MAX_HOST_INDEX_BYTES } from "./state.ts";
import {
  assertPrivateHostDirectory,
  preparePrivateHostDirectory,
  readPrivateHostJson,
} from "./private-files.ts";
import type { FileRunHostOptions } from "./file-host.ts";

const connectionSchema = z.strictObject({
  schema_version: z.literal(2),
  wire_version: z.number().int().positive(),
  artifact_id: z.string().min(1).max(256),
  policy_id: z.string().regex(/^[a-f0-9]{64}$/u),
  identity: z.string().regex(/^[a-f0-9]{64}$/u),
  host_generation: z.string().uuid(),
  host: z.string().min(1).max(256),
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  workspace_id: z.string().min(1).max(256),
  endpoint: z.string().min(1).max(512),
  credential: z.string().regex(/^[a-f0-9]{64}$/u),
});

/** Private connection authority. Never include this record in protocol DTOs, logs or guest mounts. */
export type LocalHostConnectionRecord = z.infer<typeof connectionSchema>;

/** Canonical operator-selected roots; callers cannot select another account's operator identity. */
export interface LocalHostIdentity {
  workspaceRoot: string;
  globalDir: string;
  owner: string;
  paths: LocalHostPaths;
}

/** Resolve one account/workspace namespace before either discovery or host lease acquisition. */
export async function resolveLocalHostIdentity(options: {
  workspaceRoot: string;
  globalDir?: string;
  owner?: string;
}): Promise<LocalHostIdentity> {
  const workspaceRoot = await realpath(resolve(options.workspaceRoot));
  const globalRoot = globalPaths(options.globalDir).root;
  await mkdir(globalRoot, { recursive: true, mode: DIR_MODE });
  const globalDir = await realpath(globalRoot);
  const inside = relative(workspaceRoot, globalDir);
  if (inside === "" || (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside)))
    throw kernelError("unauthorized", "local host state must be outside the selected workspace");
  const owner = options.owner ?? ownerFromWorkspace(workspaceRoot);
  const account = userInfo();
  const operatorId =
    account.uid >= 0 ? String(account.uid) : `${account.username}:${account.homedir}`;
  return {
    workspaceRoot,
    globalDir,
    owner,
    paths: localHostPaths({ workspaceRoot, globalDir, owner, operatorId }),
  };
}

/** Read a private discovery hint; only a subsequent authenticated hello proves the live host. */
export async function readLocalHostConnection(
  identity: LocalHostIdentity,
): Promise<LocalHostConnectionRecord | null> {
  const exists = await lstat(identity.paths.root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (exists === null) return null;
  const value = await readPrivateHostJson(identity.paths.connectionFile, 16 * 1024).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (value === null) return null;
  const parsed = connectionSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.identity !== identity.paths.identity ||
    parsed.data.endpoint !== identity.paths.endpoint
  )
    throw kernelError("invalid_request", "local host connection record is invalid");
  return parsed.data;
}

/** Conservative same-machine process probe; access failure and invalid PIDs are never proof of death. */
export function localHostProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

/** Lease-owned resources of one physical host generation. */
export interface LocalHostState {
  readonly generation: string;
  readonly storage: FileRunHostOptions["storage"];
  readonly lease: LocalLease;
  authenticate(token: string | undefined): "operator" | undefined;
  publish(workspaceId: string): Promise<void>;
  /** Remove only this generation's discovery record after physical shutdown, then release its lease. */
  close(): Promise<void>;
}

/** Acquire before creating a kernel. A contender never steals a live host or deletes its endpoint. */
export async function acquireLocalHostState(
  identity: LocalHostIdentity,
  artifactId: string,
  policyId: string,
  logger: Logger = NOOP_LOGGER,
): Promise<LocalHostState | null> {
  if (artifactId.length === 0 || artifactId.length > 256)
    throw kernelError("invalid_request", "local host artifact identity is invalid");
  if (!/^[a-f0-9]{64}$/u.test(policyId))
    throw kernelError("invalid_request", "local host policy identity is invalid");
  await preparePrivateHostDirectory(identity.paths.root);
  const lease = await acquireLocalLease(identity.paths.leaseFile, {
    staleMs: 30_000,
    heartbeatMs: 5_000,
    processAlive: localHostProcessAlive,
    logger,
  });
  if (lease === null) return null;
  const generation = randomUUID();
  const credential = randomBytes(32).toString("hex");
  const paths = identity.paths;
  try {
    const previous = await readLocalHostConnection(identity);
    const endpointInfo =
      paths.endpointDirectory === undefined
        ? null
        : await lstat(paths.endpoint).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
    if (previous !== null && (previous.host !== hostname() || localHostProcessAlive(previous.pid)))
      throw kernelError(
        "conflict",
        "previous host may still be alive; its ownership cannot be replaced",
      );
    if (endpointInfo !== null) {
      if (previous === null || !endpointInfo.isSocket() || endpointInfo.isSymbolicLink())
        throw kernelError("conflict", "local host endpoint has no verifiably ended owner");
      await assertPrivateHostDirectory(paths.endpointDirectory!);
      await lease.assertOwned();
      await unlink(paths.endpoint);
    }
    const saved = await readPrivateHostJson(paths.registryFile, MAX_HOST_INDEX_BYTES);
    const initialState = saved === null ? undefined : decodeHostedRegistryState(saved);
    const storage: FileRunHostOptions["storage"] = {
      initialState,
      async projection(executionId) {
        await preparePrivateHostDirectory(dirname(paths.projectionFile(generation, executionId)));
        await lease.assertOwned();
        return openHostedProjection(paths.projectionFile(generation, executionId), {
          host_generation: generation,
          execution_id: executionId,
        });
      },
      async removeProjection(executionId, runGeneration) {
        await lease.assertOwned();
        const file = paths.projectionFile(runGeneration, executionId);
        await assertPrivateHostDirectory(dirname(file)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        await unlink(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      },
      async commit(state) {
        await assertPrivateHostDirectory(paths.root);
        await lease.assertOwned();
        if (state.host_generation !== generation)
          throw kernelError("conflict", "host index commit has the wrong generation");
        decodeHostedRegistryState(state);
        await writeFileDurable(paths.registryFile, `${JSON.stringify(state)}\n`, {
          mode: FILE_MODE,
          dirMode: DIR_MODE,
        });
      },
    };
    let published = false;
    let closed = false;
    return {
      generation,
      storage,
      lease,
      authenticate(token) {
        if (closed || typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token)) return undefined;
        return timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(credential, "hex"))
          ? "operator"
          : undefined;
      },
      async publish(workspaceId) {
        if (closed || published)
          throw kernelError("conflict", "host discovery was already published or retired");
        await lease.assertOwned();
        const record: LocalHostConnectionRecord = {
          schema_version: 2,
          wire_version: CLARVIS_WIRE_VERSION,
          artifact_id: artifactId,
          policy_id: policyId,
          identity: paths.identity,
          host_generation: generation,
          host: hostname(),
          pid: process.pid,
          workspace_id: workspaceId,
          endpoint: paths.endpoint,
          credential,
        };
        published = true;
        await writeFileDurable(paths.connectionFile, `${JSON.stringify(record)}\n`, {
          mode: FILE_MODE,
          dirMode: DIR_MODE,
        });
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          if (published && (await lease.owned())) {
            const record = await readLocalHostConnection(identity);
            if (record?.host_generation === generation) await unlink(paths.connectionFile);
          }
        } finally {
          await lease.release();
        }
      },
    };
  } catch (error) {
    await bestEffort(() => lease.release(), { operation: "hosting.lease.release", logger });
    throw error;
  }
}
