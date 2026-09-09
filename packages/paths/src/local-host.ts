import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { globalPaths } from "./global.ts";

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
  /** Injectable platform for endpoint qualification. */
  platform?: NodeJS.Platform;
  /** Injectable short temporary directory; never derived from the workspace. */
  temporaryRoot?: string;
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
  /** Reconnectable endpoint, including the Windows named-pipe prefix when applicable. */
  endpoint: string;
  /** Private socket directory on POSIX; named pipes do not have a filesystem parent. */
  endpointDirectory?: string;
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
 * irrelevant to Unix socket limits. An excessively long temporary root is rejected explicitly.
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
  const usesNamedPipe = (options.platform ?? process.platform) === "win32";
  const endpointDirectory = usesNamedPipe
    ? undefined
    : join(
        resolve(options.temporaryRoot ?? tmpdir()),
        `clv-${identityOf([options.operatorId, globalDir]).slice(0, 12)}`,
      );
  const endpoint = usesNamedPipe
    ? `\\\\.\\pipe\\clarvis-${identity}`
    : join(endpointDirectory!, identity.slice(0, 32));
  if (!usesNamedPipe && Buffer.byteLength(endpoint, "utf8") > 100) {
    throw new Error("local host socket path exceeds 100 bytes; select a shorter temporary root");
  }
  return {
    identity,
    root,
    leaseFile: join(root, "host.lock"),
    connectionFile: join(root, "connection.json"),
    registryFile: join(root, "runs.json"),
    endpoint,
    ...(endpointDirectory === undefined ? {} : { endpointDirectory }),
    projectionFile: (generation, executionId) =>
      join(root, "projections", `${identityOf([generation, executionId])}.jsonl`),
  };
}
