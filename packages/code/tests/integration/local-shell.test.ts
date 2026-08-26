import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDir } from "../helpers/tracked-temp.ts";
import {
  formatBashObservation,
  runLocalBash,
  stripAnsi,
  type LocalBashResult,
} from "../../src/adapters/local-shell.ts";
import { recordDiagnostics } from "../helpers/recording-diagnostics.ts";

const cwd = process.cwd();

test("every `!` command records its outcome, and never its text", async () => {
  const recording = recordDiagnostics();
  let killed;
  try {
    await runLocalBash("printf 'secret-token-in-argv'; exit 3", { cwd });
    killed = await runLocalBash("sleep 30", { cwd, timeoutMs: 200 });
  } finally {
    recording.uninstall();
  }

  const exits = recording.of("shell.local.exit");
  expect(exits).toHaveLength(2);
  expect(exits[0]!.level).toBeUndefined();
  expect(exits[0]).toMatchObject({
    details: { exit_code: 3, killed: false, signal: null, spawn_failed: false },
  });
  expect(Number(exits[0]!.details.duration_ms)).toBeGreaterThanOrEqual(0);
  expect(exits[1]!.details.killed).toBe(true);
  expect(killed.timedOut).toBe(true);
  for (const record of exits) {
    expect(Object.keys(record.details).sort()).toEqual([
      "duration_ms",
      "exit_code",
      "killed",
      "signal",
      "spawn_failed",
    ]);
    expect(JSON.stringify(record)).not.toContain("secret-token-in-argv");
  }
});

test("captures stdout, stderr and the exit code", async () => {
  const r = await runLocalBash("printf 'a\\nb'; printf e >&2; exit 7", { cwd });
  expect(r.exitCode).toBe(7);
  expect(r.stdout).toBe("a\nb");
  expect(r.stderr).toBe("e");
  expect(r.timedOut).toBe(false);
  expect(r.cancelled).toBe(false);
  expect(r.stdoutTruncated).toBe(false);
});

test("a command that cannot be spawned settles as a failure and records why", async () => {
  const recording = recordDiagnostics();
  let result;
  try {
    result = await runLocalBash("echo hi", { cwd: join(tmpdir(), "clarvis-no-such-cwd-xyz") });
  } finally {
    recording.uninstall();
  }
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.length).toBeGreaterThan(0);
  expect(recording.first("shell.local.exit")?.details).toMatchObject({
    killed: false,
    spawn_failed: true,
  });
});

test("runs in the given cwd", async () => {
  const dir = openTempDir("clarvis-bang-");
  const r = await runLocalBash("pwd", { cwd: dir });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe(realpathSync(dir));
});

test.skipIf(process.platform === "win32")("runs bash-only syntax, not just POSIX sh", async () => {
  // `!` must keep running through `bash` specifically on POSIX hosts, even
  // though the kernel's own tools resolve to bare `sh`: on a host where
  // /bin/sh is dash or ash (Debian, Ubuntu, Alpine), `[[ ... ]]` is a syntax
  // error under sh but valid under bash.
  const r = await runLocalBash('[[ "a" == "a" ]] && echo matched', { cwd });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe("matched");
});

test("strips ANSI escapes from captured output", async () => {
  const r = await runLocalBash("printf '\\033[31mred\\033[0m plain'", { cwd });
  expect(r.stdout).toBe("red plain");
});

test("caps output without blocking the child on a full pipe", async () => {
  const r = await runLocalBash("head -c 200000 /dev/zero | tr '\\0' 'a'", {
    cwd,
    maxBytes: 1000,
  });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.length).toBeLessThanOrEqual(1000);
  expect(r.stdoutTruncated).toBe(true);
  expect(r.stderrTruncated).toBe(false);
});

// C8 regression: output of exactly maxBytes was flagged truncated by the >= cap check.
test("output of exactly maxBytes is kept whole and NOT marked truncated", async () => {
  const r = await runLocalBash("head -c 1000 /dev/zero | tr '\\0' 'a'", { cwd, maxBytes: 1000 });
  expect(r.stdout.length).toBe(1000);
  expect(r.stdoutTruncated).toBe(false);
});

test("one byte over the cap truncates to the cap", async () => {
  const r = await runLocalBash("head -c 1001 /dev/zero | tr '\\0' 'a'", { cwd, maxBytes: 1000 });
  expect(r.stdout.length).toBe(1000);
  expect(r.stdoutTruncated).toBe(true);
});

test("a grandchild holding the pipes past exit does not wedge the job", async () => {
  const started = Date.now();
  const r = await runLocalBash("sleep 5 & echo launched; exit 0", {
    cwd,
    timeoutMs: 20_000,
  });
  expect(Date.now() - started).toBeLessThan(4_000);
  expect(r.exitCode).toBe(0);
  expect(r.timedOut).toBe(false);
  expect(r.stdout).toContain("launched");
  expect(r.stdoutTruncated).toBe(false);
});

test("timeout kills the whole process group", async () => {
  const started = Date.now();
  const r = await runLocalBash("sleep 30 & sleep 30", { cwd, timeoutMs: 200 });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(r.timedOut).toBe(true);
  expect(r.exitCode).toBe(null);
  expect(r.signal).toBeTruthy();
});

test("abort signal cancels the command", async () => {
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 100);
  const started = Date.now();
  const r = await runLocalBash("sleep 5", { cwd, signal: abort.signal });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(r.cancelled).toBe(true);
  expect(r.timedOut).toBe(false);
});

test("stdin is closed so interactive commands finish immediately", async () => {
  const r = await runLocalBash("cat", { cwd, timeoutMs: 5_000 });
  expect(r.exitCode).toBe(0);
  expect(r.timedOut).toBe(false);
});

function result(over: Partial<LocalBashResult>): LocalBashResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    signal: null,
    timedOut: false,
    cancelled: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    ...over,
  };
}

test("formatBashObservation: success with stdout only", () => {
  const text = formatBashObservation("git status", result({ stdout: "clean" }));
  expect(text).toBe(
    '<bash-input>git status</bash-input>\n<bash-output exit-code="0">\nclean\n</bash-output>',
  );
});

test("formatBashObservation: stderr tag only when non-empty", () => {
  const text = formatBashObservation("x", result({ exitCode: 2, stderr: "boom" }));
  expect(text).toContain('<bash-output exit-code="2">');
  expect(text).toContain("<bash-stderr>\nboom\n</bash-stderr>");
  expect(formatBashObservation("x", result({}))).not.toContain("<bash-stderr>");
});

test("formatBashObservation: timeout and cancel markers, signal attribute", () => {
  const timedOut = formatBashObservation(
    "sleep 9",
    result({ exitCode: null, signal: "SIGTERM", timedOut: true }),
  );
  expect(timedOut).toContain('<bash-output signal="SIGTERM">');
  expect(timedOut).toContain("<bash-timed-out />");
  const cancelled = formatBashObservation(
    "sleep 9",
    result({ exitCode: null, signal: "SIGTERM", cancelled: true }),
  );
  expect(cancelled).toContain("<bash-cancelled />");
  expect(cancelled).not.toContain("<bash-timed-out />");
});

test("formatBashObservation: truncation note inside the tag", () => {
  const text = formatBashObservation("big", result({ stdout: "aaa", stdoutTruncated: true }));
  expect(text).toContain("aaa\n[output truncated]\n</bash-output>");
});

test("stripAnsi drops CSI and OSC sequences", () => {
  expect(stripAnsi("\u001b[1;32mok\u001b[0m")).toBe("ok");
  expect(stripAnsi("\u001b]0;title\u0007body")).toBe("body");
  expect(stripAnsi("plain")).toBe("plain");
});
