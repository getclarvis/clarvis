import { isAbsolute } from "node:path";
import type { DockerControl } from "../../runtime/docker-backend.ts";
import { createNodeContainerControl } from "./node-container-control.ts";

/** Explicit Docker CLI configuration; ambient context and host routing are not inherited. */
export interface NodeDockerControlOptions {
  readonly executable: string;
  readonly context: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

/** Create the argv-only Docker CLI control port. */
export function createNodeDockerControl(options: NodeDockerControlOptions): DockerControl {
  if (!isAbsolute(options.executable)) throw new Error("Docker executable must be absolute");
  if (options.context.length === 0) throw new Error("Docker context must be explicit");
  const prefix = ["--context", options.context];
  return createNodeContainerControl({ ...options, engine: "Docker", prefix });
}
