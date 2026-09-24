import type { DispatchResult } from "./core.ts";
import type { RuntimeConfig } from "./config.ts";

/** The complete set of model file operations admitted through the filesystem port. */
export const FILE_OPERATIONS = [
  "read_file",
  "read_files",
  "read_image",
  "file_stat",
  "list_dir",
  "glob",
  "grep",
  "tree",
  "diff",
  "write_file",
  "edit_file",
  "multi_edit",
  "replace",
  "apply_patch",
  "copy",
  "move",
  "mkdir",
  "remove",
] as const;

/** A closed operation name; no shell command or policy selector is part of this union. */
export type FileOperation = (typeof FILE_OPERATIONS)[number];

/** One schema-validated file call after the host has applied grants and review. */
export interface FilesystemCall {
  readonly operation: FileOperation;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * Environment-selected file execution. Host can use a local implementation;
 * Sandbox uses one run-owned isolated service.
 */
export interface AgentFilesystem {
  execute(
    call: FilesystemCall,
    config: RuntimeConfig,
    signal?: AbortSignal,
  ): Promise<DispatchResult>;
  close(deadline: number): Promise<boolean>;
}

/** Narrow runtime test that refuses unknown operations before they reach a worker. */
export function isFileOperation(value: unknown): value is FileOperation {
  return typeof value === "string" && FILE_OPERATIONS.some((operation) => operation === value);
}
