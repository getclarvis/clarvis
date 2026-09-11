import type { Readable, Writable } from "node:stream";
import { globalPaths } from "@clarvis/paths";
import { loadEnv, NOOP_LOGGER, suppressSecondaryRejection } from "@clarvis/capability";
import { kernelError } from "../core/errors.ts";
import { serveKernelOverStdio } from "../transport/stdio.ts";
import { createFileRunHost, type FileRunHost, type FileRunHostOptions } from "./file-host.ts";
import { acquireLocalHostState, resolveLocalHostIdentity } from "./local-state.ts";
import { localKernelPolicyIdentity } from "./policy-identity.ts";

/** Inputs for one process-owned hosted kernel carried by an already authenticated stdio channel. */
export interface ServeRemoteStdioOptions {
  kernel: FileRunHostOptions["kernel"];
  artifactId: string;
  input?: Readable;
  output?: Writable;
}

/** Lifetime of a remote stdio host; transport closure also initiates physical shutdown. */
export interface RemoteStdioFileKernelHost {
  readonly host: FileRunHost;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/**
 * Serve a hosted FileKernel over a single process-owned stdio connection.
 *
 * @remarks The caller must establish peer authentication before launching this process, such as an
 * SSH login. Wire parameters cannot select an owner, global root or role. The process acquires the
 * canonical workspace lease and durable hosted index, grants its sole connection operator rights,
 * withholds every machine-local application control, and shuts down after EOF. It never publishes
 * a local discovery credential or listener.
 */
export async function serveRemoteFileKernelOverStdio(
  options: ServeRemoteStdioOptions,
): Promise<RemoteStdioFileKernelHost> {
  const logger = options.kernel.logger ?? NOOP_LOGGER;
  const identity = await resolveLocalHostIdentity({
    workspaceRoot: options.kernel.workspaceRoot,
    globalDir: options.kernel.globalDir,
    owner: options.kernel.defaultOwner,
  });
  const env = options.kernel.env ?? loadEnv(options.kernel.environment?.values ?? process.env);
  const state = await acquireLocalHostState(
    identity,
    options.artifactId,
    localKernelPolicyIdentity(env),
    logger,
  );
  if (state === null) throw kernelError("conflict", "another kernel host owns this workspace");
  let host: FileRunHost | undefined;
  let closing: Promise<void> | undefined;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  try {
    host = await createFileRunHost({
      kernel: {
        ...options.kernel,
        env,
        workspaceRoot: identity.workspaceRoot,
        globalDir: identity.globalDir,
        defaultOwner: identity.owner,
        traceDir: options.kernel.traceDir ?? globalPaths(identity.globalDir).tracesDir,
      },
      hostGeneration: state.generation,
      storage: state.storage,
      authenticate: () => "operator",
      assertAuthority: () => state.lease.assertOwned(),
      exposeLocalControls: false,
      exposeDefaultOwner: true,
    });
    await host.sync();
    const owned = host;
    const pump = serveKernelOverStdio(owned.server, { input, output }, logger);
    owned.kernel.startMemoryRecovery();
    const complete = Promise.withResolvers<void>();
    suppressSecondaryRejection(complete.promise, "RemoteStdioFileKernelHost.closed");
    const close = (): Promise<void> => {
      closing ??= (async () => {
        pump.close();
        await owned.close();
        await state.close();
      })();
      void closing.then(complete.resolve, complete.reject);
      return closing;
    };
    const disconnected = (): void => {
      suppressSecondaryRejection(close(), "remote stdio host shutdown");
    };
    input.once("end", disconnected);
    input.once("error", disconnected);
    input.once("close", disconnected);
    return { host: owned, closed: complete.promise, close };
  } catch (error) {
    await host?.close().catch(() => undefined);
    await state.close().catch(() => undefined);
    throw error;
  }
}
