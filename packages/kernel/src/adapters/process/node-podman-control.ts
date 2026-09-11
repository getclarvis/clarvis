import { isAbsolute } from "node:path";
import type { PodmanControl } from "../../runtime/podman-backend.ts";
import { createNodeContainerControl } from "./node-container-control.ts";

/** Explicit CLI configuration; ambient engine-routing variables are not inherited. */
export interface NodePodmanControlOptions {
  readonly executable: string;
  readonly connection: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

/** Create the concrete argv-only Podman CLI control port. */
export function createNodePodmanControl(options: NodePodmanControlOptions): PodmanControl {
  if (!isAbsolute(options.executable)) throw new Error("Podman executable must be absolute");
  if (options.connection.length === 0) throw new Error("Podman connection must be explicit");
  const prefix = options.connection === "local" ? [] : ["--connection", options.connection];
  return createNodeContainerControl({ ...options, engine: "Podman", prefix });
}
