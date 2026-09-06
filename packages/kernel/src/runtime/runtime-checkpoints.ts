import { lstat, readFile } from "node:fs/promises";
import {
  DIR_MODE,
  FILE_MODE,
  acquireLocalLease,
  workspaceStatePaths,
  writeFileDurable,
  type RootOptions,
} from "@clarvis/paths";
import { boundJsonValue } from "../core/bounded-json.ts";

const MAX_CHECKPOINT_BYTES = 1024 * 1024;

/** Latest host-accepted reconstruction point for one guest run. */
export interface RuntimeCheckpoint {
  readonly version: 1;
  readonly generation: string;
  readonly runId: string;
  readonly sequence: number;
  readonly terminal: boolean;
  readonly state: unknown;
  readonly acceptedAt: number;
}

/** Guest checkpoint request before host durability acknowledgement. */
export interface RuntimeCheckpointInput {
  readonly generation: string;
  readonly runId: string;
  readonly sequence: number;
  readonly terminal: boolean;
  readonly state: unknown;
}

export class RuntimeCheckpointError extends Error {
  readonly code: "checkpoint_conflict" | "checkpoint_corrupt" | "checkpoint_too_large";

  constructor(code: RuntimeCheckpointError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeCheckpointError";
    this.code = code;
  }
}

function isCheckpoint(value: unknown): value is RuntimeCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const checkpoint = value as RuntimeCheckpoint;
  return (
    checkpoint.version === 1 &&
    typeof checkpoint.generation === "string" &&
    typeof checkpoint.runId === "string" &&
    Number.isSafeInteger(checkpoint.sequence) &&
    checkpoint.sequence > 0 &&
    typeof checkpoint.terminal === "boolean" &&
    Number.isSafeInteger(checkpoint.acceptedAt)
  );
}

async function readCheckpoint(path: string): Promise<RuntimeCheckpoint | null> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info === null) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CHECKPOINT_BYTES) {
    throw new RuntimeCheckpointError("checkpoint_corrupt", "checkpoint file is unsafe");
  }
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isCheckpoint(value)) throw new Error("invalid checkpoint shape");
    return value;
  } catch (cause) {
    throw new RuntimeCheckpointError("checkpoint_corrupt", "checkpoint file is invalid", {
      cause,
    });
  }
}

/** Read the last accepted checkpoint used to reconstruct a replacement guest. */
export async function loadRuntimeCheckpoint(
  workspaceRoot: string,
  generation: string,
  runId: string,
  roots?: RootOptions,
): Promise<RuntimeCheckpoint | null> {
  const path = workspaceStatePaths(workspaceRoot, roots).runtimeCheckpointFile(generation, runId);
  const checkpoint = await readCheckpoint(path);
  if (checkpoint !== null && (checkpoint.generation !== generation || checkpoint.runId !== runId)) {
    throw new RuntimeCheckpointError("checkpoint_corrupt", "checkpoint identity mismatch");
  }
  return checkpoint;
}

/** Durably accept the next checkpoint, refusing gaps, rewinds and post-terminal updates. */
export async function appendRuntimeCheckpoint(
  workspaceRoot: string,
  input: RuntimeCheckpointInput,
  roots?: RootOptions,
  now: () => number = Date.now,
): Promise<RuntimeCheckpoint> {
  const path = workspaceStatePaths(workspaceRoot, roots).runtimeCheckpointFile(
    input.generation,
    input.runId,
  );
  const lease = await acquireLocalLease(`${path}.lock`, {
    staleMs: 30_000,
    waitMs: 2_000,
    retryMs: 25,
    heartbeatMs: 5_000,
  });
  if (lease === null) {
    throw new RuntimeCheckpointError("checkpoint_conflict", "checkpoint is being updated");
  }
  try {
    const prior = await loadRuntimeCheckpoint(workspaceRoot, input.generation, input.runId, roots);
    if (prior?.terminal === true || input.sequence !== (prior?.sequence ?? 0) + 1) {
      throw new RuntimeCheckpointError(
        "checkpoint_conflict",
        "checkpoint sequence is stale, missing, or already terminal",
      );
    }
    const bounded = boundJsonValue(input.state, {
      maxDepth: 32,
      maxNodes: 32_768,
      maxChars: MAX_CHECKPOINT_BYTES / 2,
    });
    if (bounded.truncated) {
      throw new RuntimeCheckpointError("checkpoint_too_large", "checkpoint exceeds its bound");
    }
    const checkpoint: RuntimeCheckpoint = {
      version: 1,
      generation: input.generation,
      runId: input.runId,
      sequence: input.sequence,
      terminal: input.terminal,
      state: bounded.value,
      acceptedAt: now(),
    };
    const serialized = `${JSON.stringify(checkpoint, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_CHECKPOINT_BYTES) {
      throw new RuntimeCheckpointError("checkpoint_too_large", "checkpoint exceeds its bound");
    }
    await lease.assertOwned();
    await writeFileDurable(path, serialized, { mode: FILE_MODE, dirMode: DIR_MODE });
    return checkpoint;
  } finally {
    await lease.release();
  }
}

/** One host-owned durability participant required before terminal acknowledgement. */
export interface RuntimeSettlementParticipant {
  readonly name: "session" | "trace" | "capabilities" | "workspace";
  commit(): Promise<void>;
}

/** Persist the terminal checkpoint and every host store before reporting completion. */
export async function settleRuntimeTerminal(options: {
  readonly workspaceRoot: string;
  readonly checkpoint: RuntimeCheckpointInput & { readonly terminal: true };
  readonly participants: readonly RuntimeSettlementParticipant[];
  readonly roots?: RootOptions;
  readonly now?: () => number;
}): Promise<RuntimeCheckpoint> {
  const names = new Set(options.participants.map((participant) => participant.name));
  for (const required of ["session", "trace", "capabilities", "workspace"] as const) {
    if (!names.has(required)) {
      throw new RuntimeCheckpointError(
        "checkpoint_conflict",
        `terminal settlement is missing '${required}' durability`,
      );
    }
  }
  for (const participant of options.participants) await participant.commit();
  return appendRuntimeCheckpoint(
    options.workspaceRoot,
    options.checkpoint,
    options.roots,
    options.now,
  );
}
