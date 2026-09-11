import { createServer, type Server, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

import {
  RuntimeLaunchError,
  type RuntimePortPreview,
  type RuntimePreviewProtocol,
} from "./types.ts";

/** Fixed executable path admitted by both container backends for preview relays. */
const RUNTIME_GUEST_EXECUTABLE = "/usr/local/bin/clarvis-runtime";

/** Attached engine process that carries one raw TCP stream through container stdio. */
export interface RuntimePreviewAttachedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<number | null>;
  kill(signal: NodeJS.Signals): void;
}

/** Host-owned loopback forwarder for explicitly selected guest TCP ports. */
export interface RuntimePortPreviewBroker {
  expose(
    guestPort: number,
    protocol?: RuntimePreviewProtocol,
    signal?: AbortSignal,
  ): Promise<RuntimePortPreview>;
  close(): Promise<void>;
}

/** Minimal container-engine control surface needed by the fixed preview exec path. */
export interface RuntimePreviewControl {
  run(args: readonly string[], signal?: AbortSignal): Promise<{ readonly exitCode: number | null }>;
  attach(args: readonly string[]): RuntimePreviewAttachedProcess;
}

interface PortMapping {
  readonly guestPort: number;
  readonly hostPort: number;
  readonly server: Server;
}

const LOOPBACK = "127.0.0.1" as const;

function validPort(port: number): boolean {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535;
}

function validProtocol(value: unknown): value is RuntimePreviewProtocol {
  return value === "http" || value === "https" || value === "tcp";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("runtime preview cancelled");
}

function preview(mapping: PortMapping, protocol: RuntimePreviewProtocol): RuntimePortPreview {
  return {
    guestPort: mapping.guestPort,
    host: LOOPBACK,
    hostPort: mapping.hostPort,
    protocol,
    url: `${protocol}://${LOOPBACK}:${String(mapping.hostPort)}${protocol === "tcp" ? "" : "/"}`,
  };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error): void => {
      server.off("listening", ready);
      reject(error);
    };
    const ready = (): void => {
      server.off("error", failed);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("runtime preview listener returned no TCP address"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", failed);
    server.once("listening", ready);
    server.listen({ host: LOOPBACK, port, exclusive: true });
  });
}

function mayFallback(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EADDRINUSE" || code === "EACCES";
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Create a bounded TCP relay that publishes only selected guest ports on host loopback.
 *
 * @param options.probe - Verifies that the guest port is already accepting TCP connections.
 * @param options.attach - Starts one fixed engine exec relay per accepted host connection.
 * @param options.maxPorts - Maximum distinct guest ports retained by this runtime; defaults to 16.
 * @param options.maxConnections - Maximum simultaneous relay processes; defaults to 32.
 * @returns A broker whose mappings live until {@link RuntimePortPreviewBroker.close}.
 * @remarks The guest never supplies a host address, host port, executable or engine argument. The
 * requested guest port is tried on host loopback first for developer convenience; an occupied or
 * privileged host port falls back to an ephemeral loopback port.
 */
export function createRuntimePortPreviewBroker(options: {
  readonly probe: (guestPort: number, signal?: AbortSignal) => Promise<void>;
  readonly attach: (guestPort: number) => RuntimePreviewAttachedProcess;
  readonly maxPorts?: number;
  readonly maxConnections?: number;
}): RuntimePortPreviewBroker {
  const maxPorts = Math.max(1, Math.min(64, Math.floor(options.maxPorts ?? 16)));
  const maxConnections = Math.max(1, Math.min(256, Math.floor(options.maxConnections ?? 32)));
  const mappings = new Map<number, PortMapping>();
  const pending = new Map<number, Promise<PortMapping>>();
  const sockets = new Set<Socket>();
  const relays = new Set<RuntimePreviewAttachedProcess>();
  let closed = false;

  const accept = (guestPort: number, socket: Socket): void => {
    if (closed || relays.size >= maxConnections) {
      socket.destroy();
      return;
    }
    let relay: RuntimePreviewAttachedProcess;
    try {
      relay = options.attach(guestPort);
    } catch {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    relays.add(relay);
    socket.on("error", () => undefined);
    relay.stdin.on("error", () => socket.destroy());
    relay.stdout.on("error", () => socket.destroy());
    relay.stderr.on("error", () => undefined);
    relay.stderr.resume();
    socket.pipe(relay.stdin);
    relay.stdout.pipe(socket);
    let exited = false;
    const release = (kill: boolean): void => {
      sockets.delete(socket);
      relays.delete(relay);
      if (kill && !exited) relay.kill("SIGTERM");
    };
    socket.once("close", () => release(true));
    void relay.exited.then(
      () => {
        exited = true;
        release(false);
        socket.end();
      },
      () => {
        exited = true;
        release(false);
        socket.destroy();
      },
    );
  };

  const open = async (guestPort: number, signal?: AbortSignal): Promise<PortMapping> => {
    if (closed) throw new RuntimeLaunchError("operational_failure", "runtime preview is closed");
    if (mappings.size + pending.size >= maxPorts) {
      throw new RuntimeLaunchError(
        "operational_failure",
        `runtime preview port limit (${String(maxPorts)}) is exhausted`,
      );
    }
    await options.probe(guestPort, signal);
    if (closed) throw new RuntimeLaunchError("operational_failure", "runtime preview is closed");
    let server = createServer((socket) => accept(guestPort, socket));
    let hostPort: number;
    try {
      hostPort = await listen(server, guestPort);
    } catch (error) {
      if (!mayFallback(error)) throw error;
      server.removeAllListeners();
      server = createServer((socket) => accept(guestPort, socket));
      hostPort = await listen(server, 0);
    }
    const mapping = { guestPort, hostPort, server };
    mappings.set(guestPort, mapping);
    return mapping;
  };

  return {
    async expose(guestPort, protocol = "http", signal) {
      if (!validPort(guestPort)) {
        throw new RuntimeLaunchError(
          "operational_failure",
          "runtime preview guest port must be an integer from 1 through 65535",
        );
      }
      if (!validProtocol(protocol)) {
        throw new RuntimeLaunchError(
          "operational_failure",
          "runtime preview protocol must be http, https or tcp",
        );
      }
      throwIfAborted(signal);
      const existing = mappings.get(guestPort);
      if (existing !== undefined) return preview(existing, protocol);
      let opening = pending.get(guestPort);
      if (opening === undefined) {
        opening = open(guestPort, signal);
        pending.set(guestPort, opening);
        void opening.finally(() => pending.delete(guestPort)).catch(() => undefined);
      }
      const mapping = await opening;
      throwIfAborted(signal);
      return preview(mapping, protocol);
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(pending.values());
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      for (const relay of relays) relay.kill("SIGTERM");
      relays.clear();
      const servers = [...mappings.values()].map((mapping) => closeServer(mapping.server));
      mappings.clear();
      await Promise.allSettled(servers);
    },
  };
}

/**
 * Bind the generic loopback broker to one already-admitted Docker or Podman container.
 *
 * @param control - Fixed engine CLI adapter selected by the host.
 * @param containerName - Host-derived container identity; guest input cannot change it.
 * @returns A lazy broker that uses only the standalone runtime's probe and relay subcommands.
 */
export function createContainerRuntimePortPreview(
  control: RuntimePreviewControl,
  containerName: string,
): RuntimePortPreviewBroker {
  return createRuntimePortPreviewBroker({
    async probe(guestPort, signal) {
      const result = await control.run(
        ["exec", containerName, RUNTIME_GUEST_EXECUTABLE, "preview-probe", String(guestPort)],
        signal,
      );
      if (result.exitCode !== 0) {
        throw new RuntimeLaunchError(
          "operational_failure",
          `guest TCP port ${String(guestPort)} is not accepting connections`,
        );
      }
    },
    attach: (guestPort) =>
      control.attach([
        "exec",
        "--interactive",
        containerName,
        RUNTIME_GUEST_EXECUTABLE,
        "preview-relay",
        String(guestPort),
      ]),
  });
}
