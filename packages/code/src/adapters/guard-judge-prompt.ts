import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { ClarvisDirs } from "./agents.ts";

/** Compatibility value for absent guidance; the kernel always supplies its own safety policy. */
export const DEFAULT_GUARD_JUDGE_PROMPT = "";

/** Additional reviewer guidance and its source, never a replacement system policy. */
export interface GuardJudgePrompt {
  prompt: string;
  source: "workspace" | "global" | "builtin";
}

/**
 * Guidance is bounded to the request schema's limit. Oversize input is absent rather
 * than truncated; the kernel's invariant policy is always present independently.
 */
const MAX_GUARD_JUDGE_PROMPT_BYTES = 32768;

function readPrompt(file: string | undefined): string | undefined {
  if (!file) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    if (size > MAX_GUARD_JUDGE_PROMPT_BYTES) return undefined;
    const buffer = Buffer.allocUnsafe(Math.min(size + 1, MAX_GUARD_JUDGE_PROMPT_BYTES + 1));
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, read);
      if (count === 0) break;
      read += count;
    }
    if (read > MAX_GUARD_JUDGE_PROMPT_BYTES) return undefined;
    const text = buffer.subarray(0, read).toString("utf8");
    return text.trim().length > 0 ? text : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Resolves the guard-judge prompt to use: a workspace-local `guard-judge.md`
 * wins, then a global one, then {@link DEFAULT_GUARD_JUDGE_PROMPT}.
 *
 * @remarks A file that exists but is blank (or unreadable) is treated as
 *   absent, falling through to the next scope.
 */
export function loadGuardJudgePrompt(dirs: ClarvisDirs): GuardJudgePrompt {
  const workspace = readPrompt(dirs.workspace?.guardJudgeFile);
  if (workspace !== undefined) return { prompt: workspace, source: "workspace" };
  const global = readPrompt(dirs.global.guardJudgeFile);
  if (global !== undefined) return { prompt: global, source: "global" };
  return { prompt: DEFAULT_GUARD_JUDGE_PROMPT, source: "builtin" };
}
