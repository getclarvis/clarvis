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
import { spawnSync } from "node:child_process";
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
  DEFAULT_MONITOR_READY_TIMEOUT_MS,
  DEFAULT_MAX_MONITORS,
  DEFAULT_REGEX_SCAN_BUDGET_MS,
  type ServerConfig,
} from "../../src/config.ts";
import { NOOP_TOOLS_LOGGER } from "../../src/lib/log.ts";
import { contentText, type ContentPart, type ToolResult } from "../../src/tools/content.ts";
import { workspaceStatePaths } from "@clarvis/paths";
import type { GuardReview } from "../../src/guard/types.ts";

export function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "clarvis-test-"));
}

// Windows refuses to unlink a file another process still holds open, and
// `taskkill` returns as soon as the kill is *requested* - the handles a
// monitor's log holds are released a moment later, so a teardown that runs
// straight after it races and throws EBUSY. Retrying briefly is enough;
// `maxRetries` alone is not, because Bun's rmSync does not back off on EBUSY.
export function cleanup(root: string): void {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") || Date.now() > deadline) {
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export function makeConfig(root: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
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
    monitorReadyTimeoutMs: DEFAULT_MONITOR_READY_TIMEOUT_MS,
    maxMonitors: DEFAULT_MAX_MONITORS,
    regexScanBudgetMs: DEFAULT_REGEX_SCAN_BUDGET_MS,
    ripgrepAvailable: false,
    readOnly: false,
    confineToWorkspace: true,
    stateRoot: workspaceStatePaths(root).root,
    temporaryRoots: [],
    gitMetadataPaths: [],
    registerTemporaryRoot() {},
    ...overrides,
  };
}

export interface CallResult {
  isError: boolean;
  text: string;

  json: Record<string, unknown>;

  content: ContentPart[];

  meta?: Record<string, unknown>;
  guard?: GuardReview;
}

export function resultText(content: ContentPart[]): string {
  return contentText(content);
}

export function handlerText(out: string | ToolResult): string {
  const content = typeof out === "string" ? out : out.content;
  return typeof content === "string" ? content : resultText(content);
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
    ...(r.guard ? { guard: r.guard } : {}),
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
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC",
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

/**
 * Whether POSIX mode bits actually deny access on this host.
 *
 * Root ignores them, and so does Windows, where `chmod` only toggles the
 * read-only attribute and does nothing at all to a directory. Both make a
 * "permission denied" assertion fail for the same reason, so they share one
 * predicate rather than growing a second Windows-specific idiom.
 */
export const modeBitsEnforced = process.platform !== "win32" && !isRoot;

/**
 * Whether the host shell speaks POSIX syntax.
 *
 * Windows runs commands through PowerShell (see `resolveShell`), which shares
 * none of `printf`, `1>&2`, `$$`, `seq`, `yes`, `trap` or `while [ ]`. A fixture
 * written in that dialect is asserting *tool* behaviour - paging, byte caps,
 * partial-line handling, signal reporting - and only reaches for a shell to
 * produce the output; the dialect is incidental to what is under test. Scoping
 * those to POSIX keeps the Windows job asserting what it can actually speak to;
 * `ci.yml` deliberately runs only selected package surfaces there.
 */
export const posixShell = process.platform !== "win32";

/**
 * A shell fragment that runs `sleep 1` in a *new session*, or `undefined` when
 * this host offers no way to ask for one.
 *
 * Escaping the session is what leaves the spawned process group empty by the
 * time the tool kills it, which is the only way to exercise `killTree`'s
 * fallback from `kill(-pgid)` to `child.kill()`. `setsid(1)` is util-linux and
 * simply absent on macOS and the BSDs, where the command merely fails and the
 * shell exits promptly — so the fixture stopped constructing the scenario at all
 * and the test passed vacuously on Linux while failing everywhere else. Perl
 * ships with macOS and every mainstream Linux and exposes the same `setsid(2)`,
 * so it stands in where the binary is missing.
 *
 * Windows is handed the original fragment unprobed. The scenario it builds there
 * is a different one — PowerShell's `&` is a background *job* — but the fixture
 * has always passed on that platform, and `commandExists` cannot speak to it
 * (`command -v` is not a thing in PowerShell), so probing would silently turn a
 * passing Windows test into a skipped one.
 */
export const detachedSleepCommand = ((): string | undefined => {
  const viaSetsid = "setsid sleep 1";
  if (process.platform === "win32") return viaSetsid;
  if (commandExists("setsid")) return viaSetsid;
  if (commandExists("perl")) return `perl -e 'use POSIX; setsid; exec @ARGV' sleep 1`;
  return undefined;
})();

/** Whether `name` resolves on the host PATH. */
function commandExists(name: string): boolean {
  const probe = spawnSync("command", ["-v", name], { shell: true, stdio: "ignore" });
  return probe.status === 0;
}

/**
 * Whether this filesystem can hold a filename that is not valid UTF-8.
 *
 * Linux treats a filename as an opaque byte string, so an arbitrary `0xFF` is a
 * legal name and a tool that walks the tree has to cope with it. macOS does not:
 * APFS and HFS+ validate encoding and reject the byte outright with `EILSEQ`, so
 * the input under test cannot be brought into existence there at all.
 *
 * Probed rather than derived from `process.platform`, because this is a property
 * of the *filesystem* and not of the OS — a case-sensitive volume, a network
 * mount or a container image can each answer differently on the same host.
 */
export const nonUtf8FilenamesSupported = ((): boolean => {
  if (process.platform === "win32") return false;
  const probe = Buffer.concat([
    Buffer.from(path.join(tmpdir(), "clarvis-utf8-probe-")),
    Buffer.from([0xff]),
  ]);
  try {
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Whether a monitor's log actually captures the output of its child.
 *
 * False on Windows, and not because anything about those fixtures is
 * POSIX-specific - it is an open defect. `monitor_start` redirects the child's
 * stdout and stderr into an inherited descriptor, and on Windows nothing ever
 * arrives: the log is empty, not merely differently encoded or line-ended. The
 * write side is the only part implicated - reads stat and read the log by path,
 * inheriting nothing, and every monitor test that asserts bookkeeping rather
 * than captured output passes there. `shell` is unaffected because it captures
 * over pipes instead.
 *
 * This predicate exists to keep that distinct from {@link posixShell}: these
 * tests are suppressed because the product is broken on Windows, not because
 * they do not apply to it. See the Windows section of `AGENTS.md`.
 */
export const monitorCapturesOutput = process.platform !== "win32";

/**
 * Whether "settled on the shell's exit rather than waiting for a backgrounded
 * child" can be decided by a stopwatch on this host.
 *
 * False on Windows, and not for lack of trying: two budgets were measured off
 * it and both were wrong. `&` does not mean there what it means in `sh` — it is
 * PowerShell's background-*job* operator, which starts a job hosted in a second
 * PowerShell runspace, and that startup was observed at 4081ms on one
 * windows-latest runner and **12993ms** on another. The second number is the
 * damning one: it is longer than the 10s child the fixture backgrounds, so on
 * that run no threshold could tell "returned promptly" apart from "waited for
 * the child". The measurement is not merely noisy there, it is undecidable, and
 * a threshold picked anyway is a coin toss wearing an assertion's clothes.
 *
 * This suppresses **only the stopwatch**. Every assertion describing what the
 * call actually did — no error, exit 0, `ready` on stdout, `timed_out` false —
 * still runs on Windows, which is the part {@link posixShell} exists to protect.
 * Restoring a timing check there means making the property structural rather
 * than temporal: have the child touch a marker file and assert the marker is
 * absent when the call returns.
 */
export const backgroundSettleIsMeasurable = process.platform !== "win32";

/**
 * Whether this host can create symlinks.
 *
 * Probed rather than assumed from the platform: Windows can, given Developer
 * Mode or elevation, so a plain `skipIf(win32)` would drop coverage on machines
 * that actually support it.
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

/**
 * Create a symlink, choosing the link type Windows needs.
 *
 * @param kind - `"dir"` produces a junction, which is the only directory link
 *   Windows creates without elevation. Node defaults `type` to `"file"` there,
 *   so a directory link made without this silently points at nothing.
 */
export function makeSymlink(target: string, link: string, kind: "file" | "dir" = "file"): void {
  symlinkSync(target, link, kind === "dir" && process.platform === "win32" ? "junction" : kind);
}

/**
 * Normalize CRLF to LF for an output assertion.
 *
 * PowerShell terminates its lines with `\r\n`, so a fixture comparing against
 * `"hello\n"` fails on the line ending alone - a whole class of failure that
 * says nothing about the behaviour under test.
 */
export function lines(text: unknown): string {
  return String(text).replace(/\r\n/g, "\n");
}
