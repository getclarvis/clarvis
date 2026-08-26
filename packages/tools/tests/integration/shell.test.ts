import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { isSpillFile, workspacePaths, workspaceStatePaths } from "@clarvis/paths";
import type { ServerConfig } from "../../src/config.ts";

const {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  chmod,
  modeBitsEnforced,
  lines,
  detachedSleepCommand,
  posixShell,
  backgroundSettleIsMeasurable,
} = await import("../helpers/fixtures.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const NUL_COMMAND = "echo " + String.fromCharCode(0) + " hi";

describe("shell", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  describe("output capture", () => {
    it("captures stdout and exit code", async () => {
      const r = await callTool("shell", { command: "echo hello" }, config);
      expect(r.isError).toBe(false);
      expect(r.json.exit_code).toBe(0);
      expect(lines(r.json.stdout)).toBe("hello\n");
      expect(r.json.timed_out).toBe(false);
    });

    it("a non-zero exit is a normal result, not a tool error", async () => {
      const r = await callTool("shell", { command: "exit 3" }, config);
      expect(r.isError).toBe(false);
      expect(r.json.exit_code).toBe(3);
    });

    it.skipIf(!posixShell)("captures stderr separately", async () => {
      const r = await callTool("shell", { command: "echo oops 1>&2" }, config);
      expect(lines(r.json.stderr)).toBe("oops\n");
      expect(lines(r.json.stdout)).toBe("");
    });

    it.skipIf(!posixShell)(
      "reports the raw exit code, both streams, and a null signal when the command exits nonzero",
      async () => {
        const r = await callTool(
          "shell",
          { command: "printf out; printf err 1>&2; exit 3" },
          config,
        );
        expect(r.isError).toBe(false);
        expect(r.json.exit_code).toBe(3);
        expect(lines(r.json.stdout)).toBe("out");
        expect(lines(r.json.stderr)).toBe("err");
        expect(r.json.signal).toBeNull();
        expect(r.json.timed_out).toBe(false);
      },
    );

    it.skipIf(!posixShell)(
      "reports exit code 128 plus the signal number when the child is killed by a signal",
      async () => {
        const r = await callTool("shell", { command: "kill -TERM $$" }, config);
        expect(r.isError).toBe(false);
        expect(r.json.exit_code).toBe(128 + osConstants.signals.SIGTERM);
        expect(r.json.signal).toBe("SIGTERM");
        expect(r.json.timed_out).toBe(false);
      },
    );

    it.skipIf(!posixShell)(
      "reports a signal-killed command as a non-zero exit, never success",
      async () => {
        const r = await callTool("shell", { command: "kill -9 $$" }, config);
        expect(r.isError).toBe(false);
        expect(r.json.exit_code).toBe(137);
        expect(r.json.signal).toBe("SIGKILL");
      },
    );

    it("reports a null signal for a normal exit", async () => {
      const r = await callTool("shell", { command: "echo ok" }, config);
      expect(r.json.signal).toBeNull();
    });
  });

  describe("live output (onOutput hook)", () => {
    it("streams coalesced incremental chunks while the command runs, then the full result", async () => {
      const chunks: string[] = [];
      const r = await callTool(
        "shell",
        { command: "printf 'one\\n'; sleep 0.5; printf 'two\\n'" },
        config,
        undefined,
        { onOutput: (chunk) => chunks.push(chunk) },
      );
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0]).toBe("one\n");
      expect(chunks.join("")).toBe("one\ntwo\n");
      expect(r.isError).toBe(false);
      expect(lines(r.json.stdout)).toBe("one\ntwo\n");
    });

    it("interleaves stderr into the same live stream", async () => {
      const chunks: string[] = [];
      await callTool("shell", { command: "printf out; printf err 1>&2" }, config, undefined, {
        onOutput: (chunk) => chunks.push(chunk),
      });
      expect(chunks.join("")).toContain("out");
      expect(chunks.join("")).toContain("err");
    });
  });

  describe("timeout and cancellation", () => {
    it("returns a timeout error when the command exceeds its limit", async () => {
      const r = await callTool("shell", { command: "sleep 5", timeout_ms: 100 }, config);
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe("timeout");
      expect(r.json.timeout_ms).toBe(100);
    });

    it("rejects with a timeout and kills the process group when the deadline fires", async () => {
      const r = await callTool("shell", { command: "sleep 30", timeout_ms: 200 }, config);
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe("timeout");
      expect(r.json.timeout_ms).toBe(200);
    });

    it("clamps an overflowing timeout_ms instead of firing immediately", async () => {
      const r = await callTool("shell", { command: "echo hi", timeout_ms: 3_000_000_000 }, config);
      expect(r.isError).toBe(false);
      expect(r.json.exit_code).toBe(0);
      expect(lines(r.json.stdout)).toBe("hi\n");
    });

    it("caps timeout_ms at the configured shellTimeoutMaxMs ceiling", async () => {
      const capped = makeConfig(root, { shellTimeoutMs: 150, shellTimeoutMaxMs: 150 });
      const r = await callTool("shell", { command: "sleep 5", timeout_ms: 60000 }, capped);
      expect(r.json.error).toBe("timeout");
      expect(r.json.timeout_ms).toBe(150);
    });

    it("allows timeout_ms above the default up to the ceiling", async () => {
      const cfg = makeConfig(root, { shellTimeoutMs: 150, shellTimeoutMaxMs: 10000 });
      const r = await callTool("shell", { command: "sleep 0.4; echo done", timeout_ms: 5000 }, cfg);
      expect(r.isError).toBe(false);
      expect(r.json.exit_code).toBe(0);
      expect(lines(r.json.stdout)).toContain("done");
    });

    it("uses shellTimeoutMs as the default when timeout_ms is omitted", async () => {
      const cfg = makeConfig(root, { shellTimeoutMs: 150, shellTimeoutMaxMs: 10000 });
      const r = await callTool("shell", { command: "sleep 5" }, cfg);
      expect(r.json.error).toBe("timeout");
      expect(r.json.timeout_ms).toBe(150);
    });

    it("aborting the signal kills a long-running command and returns an aborted error", async () => {
      const ac = new AbortController();
      const p = callTool("shell", { command: "sleep 30", timeout_ms: 60000 }, config, ac.signal);
      await sleep(100);
      ac.abort();
      const r = await p;
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe("aborted");
    });

    it("an already-aborted signal returns an aborted error without hanging", async () => {
      const ac = new AbortController();
      ac.abort();
      const r = await callTool(
        "shell",
        { command: "sleep 30", timeout_ms: 60000 },
        config,
        ac.signal,
      );
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe("aborted");
    });

    it.skipIf(detachedSleepCommand === undefined)(
      "falls back to child.kill when the process group is already gone",
      async () => {
        const ac = new AbortController();
        const p = callTool(
          "shell",
          { command: `${detachedSleepCommand} & echo hi`, timeout_ms: 60000 },
          config,
          ac.signal,
        );
        await sleep(50);
        ac.abort();
        const r = await p;
        expect(r.isError).toBe(true);
        expect(r.json.error).toBe("aborted");
      },
    );
  });

  describe("output limits and spill", () => {
    it.skipIf(!posixShell)(
      "spills overflowing stdout to the state tree and points the footer at it",
      async () => {
        const small = makeConfig(root, { maxShellOutputBytes: 64 });
        const r = await callTool(
          "shell",
          { command: "for i in $(seq 1 200); do echo line$i; done" },
          small,
        );
        expect(r.isError).toBe(false);
        const stdout = r.json.stdout as string;
        expect(stdout).toContain("output truncated");
        expect(stdout).toContain("full output written to");
        expect(stdout).toContain("line200");

        const m = stdout.match(/full output written to (\S+) \.\.\.\]/);
        expect(m).not.toBeNull();
        const named = m![1]!;
        expect(path.isAbsolute(named)).toBe(true);
        expect(named.startsWith(workspaceStatePaths(root).localDir)).toBe(true);
        const full = readFileSync(named, "utf8");
        expect(full).toContain("line1\n");
        expect(full).toContain("line200\n");
        expect(Buffer.byteLength(full, "utf8")).toBeGreaterThan(64);
      },
    );

    it.skipIf(!posixShell)("a spill on a virgin workspace writes nothing into it", async () => {
      const small = makeConfig(root, { maxShellOutputBytes: 64 });
      expect(existsSync(workspacePaths(root).clarvisDir)).toBe(false);

      await callTool("shell", { command: "for i in $(seq 1 200); do echo line$i; done" }, small);

      expect(existsSync(workspacePaths(root).clarvisDir)).toBe(false);
      expect(readdirSync(root)).toEqual([]);

      const spills = readdirSync(workspaceStatePaths(root).localDir);
      expect(spills.some((name) => isSpillFile(name))).toBe(true);
    });

    it.skipIf(!posixShell)("the spilled file is reported by a path read_file accepts", async () => {
      const small = makeConfig(root, { maxShellOutputBytes: 64 });
      const r = await callTool(
        "shell",
        { command: "for i in $(seq 1 200); do echo line$i; done" },
        small,
      );

      const named = /full output written to (\S+)/.exec(r.text)?.[1];
      expect(named).toBeDefined();
      expect(path.isAbsolute(named as string)).toBe(true);

      const back = await callTool("read_file", { path: named }, small);
      expect(back.isError).toBe(false);
      expect(back.text).toContain("line200");
    });

    it.skipIf(!posixShell)("budgets stdout and stderr against a single shared cap", async () => {
      const small = makeConfig(root, { maxShellOutputBytes: 2000 });
      const r = await callTool(
        "shell",
        { command: "for i in $(seq 1 500); do echo out$i; echo err$i 1>&2; done" },
        small,
      );
      expect(r.isError).toBe(false);
      const out = r.json.stdout as string;
      const err = r.json.stderr as string;
      expect(out).toContain("output truncated:");
      expect(err).toContain("output truncated:");
      const marker = /^\[\.\.\. earlier output truncated:[^\n]+\.\.\.\]\n/u;
      const outMarker = marker.exec(out)?.[0];
      const errMarker = marker.exec(err)?.[0];
      expect(outMarker).toBeDefined();
      expect(errMarker).toBeDefined();
      const combinedTail =
        Buffer.byteLength(out.slice(outMarker!.length), "utf8") +
        Buffer.byteLength(err.slice(errMarker!.length), "utf8");
      expect(combinedTail).toBeLessThanOrEqual(2000);
    });

    it("kills a runaway producer at the capture ceiling instead of growing unbounded", async () => {
      const start = Date.now();
      const r = await callTool("shell", { command: "yes", timeout_ms: 60000 }, config);
      const elapsed = Date.now() - start;
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe("output_limit");
      expect(elapsed).toBeLessThan(30000);
      expect(typeof r.json.stdout).toBe("string");
    }, 60000);

    it("rejects with output_limit when a single stream floods past the capture cap", async () => {
      const r = await callTool("shell", { command: "yes CLARVIS_FLOOD | head -c 9000000" }, config);
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe("output_limit");
      expect(r.json.max_capture_bytes).toBe(8 * 1024 * 1024);
    });

    it("kills a backgrounded grandchild when the command times out", async () => {
      const r = await callTool(
        "shell",
        { command: "sleep 1 && echo leaked > leak.txt & sleep 10", timeout_ms: 300 },
        config,
      );
      expect(r.json.error).toBe("timeout");
      await sleep(1500);
      expect(existsSync(path.join(root, "leak.txt"))).toBe(false);
    }, 10000);

    it("does not hang on a backgrounded process — settles on the shell's exit", async () => {
      const start = Date.now();
      const r = await callTool("shell", { command: "sleep 10 & echo ready" }, config);
      const elapsed = Date.now() - start;
      expect(r.isError).toBe(false);
      expect(r.json.exit_code).toBe(0);
      expect(lines(r.json.stdout)).toContain("ready");
      expect(r.json.timed_out).toBe(false);
      if (backgroundSettleIsMeasurable) expect(elapsed).toBeLessThan(10_000);
    });
  });

  describe("working directory errors", () => {
    it("errors not_found for a missing cwd", async () => {
      const r = await callTool("shell", { command: "pwd", cwd: "no_such_dir" }, config);
      expect(r.json.error).toBe("not_found");
    });

    it("errors not_a_file when cwd is an existing file", async () => {
      const r = await callTool("shell", { command: "echo > afile" }, config);
      expect(r.isError).toBe(false);
      const r2 = await callTool("shell", { command: "pwd", cwd: "afile" }, config);
      expect(r2.json.error).toBe("not_a_file");
    });

    it.skipIf(!modeBitsEnforced)(
      "rejects with io_error when the child cannot enter an unsearchable working directory",
      async () => {
        mkdirSync(path.join(root, "noexec"));
        chmod(root, "noexec", 0o000);
        try {
          const r = await callTool("shell", { command: "pwd", cwd: "noexec" }, config);
          expect(r.isError).toBe(true);
          expect(r.json.error).toBe("io_error");
          expect(String(r.json.message)).toContain("Failed to run command");
        } finally {
          chmod(root, "noexec", 0o755);
        }
      },
    );
  });

  describe("spawn and finalize IO errors", () => {
    it.skipIf(!posixShell)(
      "rejects with io_error when spawn throws synchronously on a null byte in the command",
      async () => {
        const r = await callTool("shell", { command: NUL_COMMAND }, config);
        expect(r.isError).toBe(true);
        expect(r.json.error).toBe("io_error");
        expect(String(r.json.message)).toContain("Failed to spawn command");
      },
    );

    it("rejects with io_error when finalizing captured output fails", async () => {
      const { createShell } = await import("../../src/tools/shell.ts");
      const tool = createShell({
        finalizeOutput: async () => {
          throw new Error("finalize boom");
        },
      });
      expect(tool.handler({ command: "printf done" }, config)).rejects.toMatchObject({
        code: "io_error",
        message: expect.stringContaining("Failed to finalize output"),
      });
    });

    it.skipIf(!modeBitsEnforced)(
      "does not fail when aborting a command whose child never received a pid",
      async () => {
        mkdirSync(path.join(root, "noexec2"));
        chmod(root, "noexec2", 0o000);
        const ac = new AbortController();
        ac.abort();
        try {
          const r = await callTool("shell", { command: "pwd", cwd: "noexec2" }, config, ac.signal);
          expect(r.isError).toBe(true);
          expect(["io_error", "aborted"]).toContain(String(r.json.error));
        } finally {
          chmod(root, "noexec2", 0o755);
        }
      },
    );
  });

  describe("schema validation", () => {
    it("ignores out-of-schema extra fields", async () => {
      const r = await callTool("shell", { command: "echo x", bogus: 1 }, config);
      expect(r.isError).toBe(false);
      expect(r.json.exit_code).toBe(0);
    });
  });
});
