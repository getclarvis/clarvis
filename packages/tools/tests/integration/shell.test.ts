import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { isSpillFile, workspacePaths } from "@clarvis/paths";
import type { ServerConfig } from "../../src/config.ts";
import { createShell } from "../../src/tools/shell.ts";

const {
  makeWorkspace,
  cleanup,
  makeConfig,
  fixtureStatePaths,
  callTool,
  chmod,
  modeBitsEnforced,
  lines,
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
      "joins split UTF-8 chunks and keeps output without a newline",
      async () => {
        const r = await callTool(
          "shell",
          { command: "printf '\\303'; sleep 0.02; printf '\\251'; printf err 1>&2" },
          config,
        );
        expect(r.isError).toBe(false);
        expect(r.json.stdout).toBe("é");
        expect(r.json.stderr).toBe("err");
        expect(r.json.stdout_truncated).toBe(false);
        expect(r.json.stderr_truncated).toBe(false);
        expect(r.json.stdout_omitted_bytes).toBe(0);
      },
    );

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
    it("publishes successful spawn once before output, with abort handling already installed", async () => {
      const events: string[] = [];
      const controller = new AbortController();
      const result = await callTool("shell", { command: "sleep 5" }, config, controller.signal, {
        onExecutionStarted() {
          events.push("start");
          controller.abort();
        },
        onOutput(chunk) {
          events.push(chunk);
        },
      });
      expect(events).toEqual(["start"]);
      expect(result.json.error).toBe("aborted");
    });

    it("does not publish started on an asynchronous spawn failure", async () => {
      const events: string[] = [];
      const cwd = path.join(root, "vanishing-cwd");
      mkdirSync(cwd);
      config = {
        ...config,
        logger: {
          ...config.logger,
          debug(fields) {
            if (fields.event === "tools.shell_spawn") rmSync(cwd, { recursive: true });
          },
        },
      };
      const result = await callTool("shell", { command: "echo no", cwd }, config, undefined, {
        onExecutionStarted() {
          events.push("start");
        },
      });
      expect(result.json.error).toBe("io_error");
      expect(events).toEqual([]);
    });

    it("does not turn completed execution into abort while output is being finalized", async () => {
      const controller = new AbortController();
      const shell = createShell({
        async finalizeOutput() {
          controller.abort();
          return { stdout: "done", stderr: "" };
        },
      });
      const result = await shell.handler({ command: "echo done" }, config, controller.signal);
      expect(typeof result).toBe("string");
      expect(JSON.parse(result as string)).toMatchObject({ exit_code: 0, stdout: "done" });
    });

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

    it("keeps a completed shell successful when abort arrives after exit but before stdio close", async () => {
      const controller = new AbortController();
      const events: string[] = [];
      const shell = createShell({
        spawn: ((...args: Parameters<typeof spawn>) => {
          const child = spawn(...args);
          child.once("exit", () => {
            events.push("exit");
            controller.abort();
            events.push("abort");
          });
          child.once("close", () => events.push("close"));
          return child;
        }) as typeof spawn,
      });
      const result = await shell.handler({ command: "echo hi" }, config, controller.signal);
      expect(events).toEqual(["exit", "abort", "close"]);
      expect(controller.signal.aborted).toBe(true);
      expect(typeof result).toBe("string");
      expect(JSON.parse(result as string)).toMatchObject({
        exit_code: 0,
        stdout: expect.stringContaining("hi"),
        signal: null,
        timed_out: false,
      });
    });
  });

  describe("bounded output", () => {
    it.skipIf(!posixShell)("keeps only a bounded tail and creates no shell spill", async () => {
      const small = makeConfig(root, { maxShellOutputBytes: 64 });
      const r = await callTool(
        "shell",
        { command: "for i in $(seq 1 200); do echo line$i; done" },
        small,
      );
      expect(r.isError).toBe(false);
      expect(r.json.stdout_truncated).toBe(true);
      expect(r.json.stdout_omitted_bytes).toBeGreaterThan(0);
      expect(r.json.stdout).toContain("line200");
      expect(r.json.stdout).not.toContain("output written to");
      expect(existsSync(workspacePaths(root).clarvisDir)).toBe(false);
      expect(readdirSync(root)).toEqual([]);
      const local = fixtureStatePaths(root).localDir;
      if (existsSync(local))
        expect(readdirSync(local).some((name) => isSpillFile(name))).toBe(false);
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
      expect(r.json.stdout_truncated).toBe(true);
      expect(r.json.stderr_truncated).toBe(true);
      expect(r.json.stdout_omitted_bytes).toBeGreaterThan(0);
      expect(r.json.stderr_omitted_bytes).toBeGreaterThan(0);
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

    it("drains a continuous producer until the timeout without treating truncation as failure", async () => {
      const start = Date.now();
      const r = await callTool("shell", { command: "yes", timeout_ms: 300 }, config);
      const elapsed = Date.now() - start;
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe("timeout");
      expect(elapsed).toBeLessThan(10000);
      expect(typeof r.json.stdout).toBe("string");
      expect(r.json.stdout_truncated).toBe(true);
      expect(r.json.stdout_omitted_bytes).toBeGreaterThan(0);
    }, 60000);

    it("returns exit zero and honest truncation after a large burst", async () => {
      const r = await callTool("shell", { command: "yes CLARVIS_FLOOD | head -c 9000000" }, config);
      expect(r.isError).toBe(false);
      expect(r.json.exit_code).toBe(0);
      expect(r.json.stdout_truncated).toBe(true);
      expect(r.json.stdout_omitted_bytes).toBeGreaterThan(0);
    });

    it.skipIf(
      (process.platform !== "linux" && process.platform !== "darwin") ||
        process.env.CLARVIS_NATIVE_SANDBOX_CANARY !== "1",
    )("drains oversized output through the native sandbox", async () => {
      const isolated = makeConfig(root, {
        sandbox: { type: "native", availability: "required", network: "none" },
      });
      const r = await callTool(
        "shell",
        { command: "yes CLARVIS_FLOOD | head -c 9000000" },
        isolated,
      );
      expect(r.isError).toBe(false);
      expect(r.json.exit_code).toBe(0);
      expect(r.json.stdout_truncated).toBe(true);
    });

    it("keeps cancellation ahead of truncation after a large output burst", async () => {
      const controller = new AbortController();
      const r = await callTool(
        "shell",
        { command: "yes CLARVIS_FLOOD | head -c 9000000; sleep 30", timeout_ms: 60000 },
        config,
        controller.signal,
        {
          onOutput() {
            controller.abort();
          },
        },
      );
      expect(r.json.error).toBe("aborted");
      expect(r.json.stdout_truncated).toBe(true);
      expect(r.json.stdout_omitted_bytes).toBeGreaterThan(0);
    }, 60000);

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
    it("rejects an invalid readiness pattern before spawning", async () => {
      const r = await callTool("shell", { command: "echo x", ready_when: "[" }, config);
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe("invalid_input");
      expect(r.text).toContain("Invalid ready_when regex");
    });

    it("ignores out-of-schema extra fields", async () => {
      const r = await callTool("shell", { command: "echo x", bogus: 1 }, config);
      expect(r.isError).toBe(false);
      expect(r.json.exit_code).toBe(0);
    });
  });
});
