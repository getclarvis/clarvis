import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { globalPaths } from "./global.ts";
import { UNIX_SOCKET_PATH_BUDGET_BYTES, unixSocketPathFits } from "./short-temporaries.ts";

/** Identity inputs for the operator's single host of one canonical workspace. */
export interface LocalHostPathOptions {
  /** Canonical checkout path, resolved by the launcher before discovery. */
  workspaceRoot: string;
  /** Effective operator configuration root; never supplied by a guest. */
  globalDir: string;
  /** Kernel data owner, independently scoped from the operating-system user. */
  owner: string;
  /** Operating-system account identity used by the authenticated local launcher. */
  operatorId: string;
  /** Ordered host-owned roots considered only for the reconnectable local-host endpoint. */
  endpointRootCandidates?: readonly string[];
}

/** Private discovery, handoff and projection paths, separate from agent scratch. */
export interface LocalHostPaths {
  /** Fixed-width identity over account, owner, global root and canonical workspace. */
  identity: string;
  /** Operator-only state; hosts must enforce ownership and exclude it from tool access. */
  root: string;
  /** Cross-process lease. A record or PID alone never proves a live host's identity. */
  leaseFile: string;
  /** Private connection credentials and artifact/generation identity. */
  connectionFile: string;
  /** Durable bounded index of handoffs and terminal references. */
  registryFile: string;
  /** Reconnectable Unix socket endpoint. */
  endpoint: string;
  /** Private socket directory. */
  endpointDirectory: string;
  /** Resolve an observation projection without interpreting ids as path components. */
  projectionFile(generation: string, executionId: string): string;
}

function identityOf(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * Build a stable private host namespace and a short reconnectable IPC endpoint.
 *
 * Paths do not confer authority: the host must authenticate the peer, verify directory ownership
 * and hold the local lease. Keeping the socket under a short temporary root makes a long HOME
 * irrelevant to Unix socket limits. POSIX selection considers the complete endpoint's UTF-8 byte
 * length and has no filesystem effects; the transport remains responsible for preparing its root.
 */
export function localHostPaths(options: LocalHostPathOptions): LocalHostPaths {
  if (!options.owner || !options.operatorId) {
    throw new Error("local host paths require owner and operating-system account identities");
  }
  const globalDir = resolve(options.globalDir);
  const identity = identityOf([
    options.operatorId,
    options.owner,
    globalDir,
    resolve(options.workspaceRoot),
  ]);
  const root = join(globalPaths(globalDir).state, "hosts", identity);
  const suppliedCandidates = options.endpointRootCandidates;
  if (suppliedCandidates?.length === 0)
    throw new Error("local host endpoint root candidates must not be empty");
  const rawCandidates = suppliedCandidates ?? [tmpdir(), "/tmp"];
  if (rawCandidates.some((candidate) => candidate.length === 0 || candidate.includes("\0")))
    throw new Error("local host endpoint root candidates contain an invalid path");
  const candidates = [...new Set(rawCandidates.map((candidate) => resolve(candidate)))];
  const accountDirectory = `clv-${identityOf([options.operatorId, globalDir]).slice(0, 12)}`;
  let endpointDirectory: string | undefined;
  let endpoint: string | undefined;
  for (const candidate of candidates) {
    const directory = join(candidate, accountDirectory);
    const candidateEndpoint = join(directory, identity.slice(0, 32));
    if (unixSocketPathFits(candidateEndpoint)) {
      endpointDirectory = directory;
      endpoint = candidateEndpoint;
      break;
    }
  }
  if (endpointDirectory === undefined || endpoint === undefined)
    throw new Error(
      `no local host socket endpoint candidate fits within ${UNIX_SOCKET_PATH_BUDGET_BYTES} UTF-8 bytes (${candidates.length} candidates)`,
    );
  assert(
    unixSocketPathFits(endpoint),
    `local host socket endpoint exceeds ${UNIX_SOCKET_PATH_BUDGET_BYTES} UTF-8 bytes`,
  );
  return {
    identity,
    root,
    leaseFile: join(root, "host.lock"),
    connectionFile: join(root, "connection.json"),
    registryFile: join(root, "runs.json"),
    endpoint,
    endpointDirectory,
    projectionFile: (generation, executionId) =>
      join(root, "projections", `${identityOf([generation, executionId])}.jsonl`),
  };
}
