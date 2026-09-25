import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  chmodSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dispatch } from "../../src/core.ts";
import type { ToolCallHooks } from "../../src/tools/types.ts";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_SHELL_OUTPUT_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_TRAVERSAL_ENTRIES,
  DEFAULT_MAX_MUTATION_BYTES,
  DEFAULT_MAX_DIFF_INPUT_BYTES,
  DEFAULT_MAX_TOOL_META_BYTES,
  DEFAULT_SHELL_TIMEOUT_MS,
  DEFAULT_SHELL_TIMEOUT_MAX_MS,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_REGEX_SCAN_BUDGET_MS,
  type ServerConfig,
} from "../../src/config.ts";
import { NOOP_TOOLS_LOGGER } from "../../src/lib/log.ts";
import { contentText, type ContentPart } from "../../src/tools/content.ts";
import { workspaceStatePaths } from "@clarvis/paths";
import { ExecutionSessionManager } from "../../src/lib/execution-session.ts";

const fixtureGlobals = new Map<string, string>();

export function makeWorkspace(): string {
  const workspace = mkdtempSync(path.join(tmpdir(), "clarvis-test-"));
  fixtureGlobals.set(workspace, `${workspace}-global`);
  return workspace;
}

export function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
  const global = fixtureGlobals.get(root);
  fixtureGlobals.delete(root);
  if (global !== undefined) rmSync(global, { recursive: true, force: true });
}

export function fixtureStatePaths(root: string) {
  return workspaceStatePaths(root, {
    env: { CLARVIS_HOME: fixtureGlobals.get(root) ?? `${root}-global` },
  });
}

export function makeConfig(root: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const statePaths = overrides.statePaths ?? fixtureStatePaths(root);
  const base = {
    workspaceRoot: root,
    logger: NOOP_TOOLS_LOGGER,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    maxShellOutputBytes: DEFAULT_MAX_SHELL_OUTPUT_BYTES,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    maxTraversalEntries: DEFAULT_MAX_TRAVERSAL_ENTRIES,
    maxMutationBytes: DEFAULT_MAX_MUTATION_BYTES,
    maxDiffInputBytes: DEFAULT_MAX_DIFF_INPUT_BYTES,
    maxToolMetaBytes: DEFAULT_MAX_TOOL_META_BYTES,
    shellTimeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
    shellTimeoutMaxMs: DEFAULT_SHELL_TIMEOUT_MAX_MS,
    maxSessions: DEFAULT_MAX_SESSIONS,
    regexScanBudgetMs: DEFAULT_REGEX_SCAN_BUDGET_MS,
    readOnly: false,
    stateRoot: statePaths.root,
    statePaths,
    temporaryRoots: [],
    sessionAgent: {},
    sessionManager: new ExecutionSessionManager(),
    ...overrides,
  };
  return base;
}

export interface CallResult {
  isError: boolean;
  text: string;

  json: Record<string, unknown>;

  content: ContentPart[];

  meta?: Record<string, unknown>;
}

export function resultText(content: ContentPart[]): string {
  return contentText(content);
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  config: ServerConfig,
  signal?: AbortSignal,
  hooks?: ToolCallHooks,
): Promise<CallResult> {
  const r = await dispatch(name, args, config, signal, hooks);
  const text = resultText(r.content);
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {}
  return {
    isError: r.isError,
    text,
    json,
    content: r.content,
    ...(r.meta ? { meta: r.meta } : {}),
  };
}

export function write(root: string, rel: string, content: string): string {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

export function writeBinary(root: string, rel: string): string {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, Buffer.from([0x61, 0x00, 0x62]));
  return p;
}

const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

export function writePng(root: string, rel: string): string {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, MINIMAL_PNG);
  return p;
}

export function writeUtf16(root: string, rel: string, content: string, be = false): string {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  const buf = Buffer.from("﻿" + content, "utf16le");
  if (be) buf.swap16();
  writeFileSync(p, buf);
  return p;
}

export function read(root: string, rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

export function exists(root: string, rel: string): boolean {
  return existsSync(path.join(root, rel));
}

export function chmod(root: string, rel: string, mode: number): void {
  chmodSync(path.join(root, rel), mode);
}

export function mode(root: string, rel: string): number {
  return statSync(path.join(root, rel)).mode & 0o777;
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** Whether mode bits actually deny access on this host. */
export const modeBitsEnforced = !isRoot;

/**
 * Whether this host can create symlinks.
 *
 * Probed because filesystems may refuse symlink creation.
 */
export const canSymlink = ((): boolean => {
  const dir = mkdtempSync(path.join(tmpdir(), "clarvis-symlink-probe-"));
  try {
    symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

/** Create a file or directory symlink. */
export function makeSymlink(target: string, link: string, kind: "file" | "dir" = "file"): void {
  symlinkSync(target, link, kind);
}

/** Normalize line endings for an output assertion. */
export function lines(text: unknown): string {
  return String(text).replace(/\r\n/g, "\n");
}
