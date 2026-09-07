import { serveExecutionWorker } from "./execution-worker.ts";
import { createGuestLoopExecutor } from "./guest-loop-executor.ts";
import type { Readable, Writable } from "node:stream";

/** Start the image entrypoint only from its two immutable host-supplied identities. */
export function startGuestMain(options: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly input: Readable;
  readonly output: Writable;
}): ReturnType<typeof serveExecutionWorker> | null {
  const generation = options.environment.CLARVIS_RUNTIME_GENERATION;
  const imageDigest = options.environment.CLARVIS_RUNTIME_IMAGE_DIGEST;
  if (generation === undefined || imageDigest === undefined) return null;
  return serveExecutionWorker({
    generation,
    imageDigest,
    input: options.input,
    output: options.output,
    executor: createGuestLoopExecutor(),
  });
}

if (import.meta.main) {
  const worker = startGuestMain({
    environment: process.env,
    input: process.stdin,
    output: process.stdout,
  });
  if (worker === null) process.exitCode = 64;
}
