import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeProcessRunner } from "../../src/local.ts";
import { createGitPluginFetcher } from "../../src/adapters/git/plugin-fetcher.ts";
import type { ProcessRunner } from "../../src/ports/process-runner.ts";
import { recordingLogger } from "../helpers/logger.ts";

describe("local.process.failed", () => {
  it("rejects pre-start, in-flight, timeout, and spawn failures", async () => {
    const runner = createNodeProcessRunner();
    const already = new AbortController();
    already.abort("cancelled before start");
    await expect(
      runner.run({
        command: process.execPath,
        args: ["-e", ""],
        environment: process.env,
        signal: already.signal,
      }),
    ).rejects.toThrow("cancelled before start");

    const active = new AbortController();
    const cancelled = runner.run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      environment: process.env,
      signal: active.signal,
    });
    active.abort(new Error("cancelled in flight"));
    await expect(cancelled).rejects.toThrow("cancelled in flight");

    await expect(
      runner.run({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        environment: process.env,
        timeoutMs: 10,
      }),
    ).rejects.toThrow("timed out");
    await expect(
      runner.run({ command: "/definitely/missing/clarvis-command", args: [], environment: {} }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("reports a non-zero exit with the command name and no arguments", async () => {
    const logger = recordingLogger();
    const runner = createNodeProcessRunner(logger);
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "process.stderr.write('boom'); process.exit(3)"],
      environment: process.env,
    });
    expect(result.exitCode).toBe(3);
    const failure = logger.events("local.process.failed")[0];
    expect(failure).toMatchObject({ command: process.execPath, exit_code: 3, stderr_chars: 4 });
    expect(typeof failure?.duration_ms).toBe("number");
    expect(JSON.stringify(failure)).not.toContain("process.exit");
  });

  it("says nothing about a clean exit", async () => {
    const logger = recordingLogger();
    const runner = createNodeProcessRunner(logger);
    await runner.run({ command: process.execPath, args: ["-e", ""], environment: process.env });
    expect(logger.events("local.process.failed")).toEqual([]);
  });

  it("stays usable with no logger at all", async () => {
    const result = await createNodeProcessRunner().run({
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
      environment: process.env,
    });
    expect(result.exitCode).toBe(1);
  });
});

describe("local.git.failed", () => {
  function failingRunner(): ProcessRunner {
    return {
      async run() {
        return { exitCode: 128, stdout: "", stderr: "fatal: repository not found\n" };
      },
    };
  }

  async function hostFor(source: string): Promise<unknown> {
    const globalDir = mkdtempSync(join(tmpdir(), "clarvis-git-log-"));
    const logger = recordingLogger();
    const fetcher = createGitPluginFetcher({
      globalDir,
      processRunner: failingRunner(),
      environment: {},
      logger,
    });
    await expect(fetcher.fetch(source, undefined, undefined)).rejects.toThrow();
    rmSync(globalDir, { recursive: true, force: true });
    return logger.events("local.git.failed")[0];
  }

  it("drops repository-local Git routing before invoking the process runner", async () => {
    const globalDir = mkdtempSync(join(tmpdir(), "clarvis-git-env-"));
    let received: Readonly<Record<string, string | undefined>> | undefined;
    const processRunner: ProcessRunner = {
      async run(request) {
        received = request.environment;
        return { exitCode: 128, stdout: "", stderr: "refused" };
      },
    };
    const fetcher = createGitPluginFetcher({
      globalDir,
      processRunner,
      environment: {
        PATH: "/bin",
        GIT_DIR: "/parent/.git",
        GIT_WORK_TREE: "/parent",
        GIT_INDEX_FILE: "/parent/index",
        GIT_COMMON_DIR: "/parent/common",
      },
    });
    try {
      await expect(
        fetcher.fetch("https://example.test/plugin.git", undefined, undefined),
      ).rejects.toThrow();
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
    expect(received).toEqual({
      PATH: "/bin",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      GIT_CONFIG_NOSYSTEM: "1",
    });
  });

  it("keeps the host and drops everything a URL could hide", async () => {
    expect(await hostFor("https://alice:s3cret@github.com/acme/plugin.git")).toMatchObject({
      op: "clone",
      repo_host: "github.com",
      cause: expect.stringContaining("repository not found"),
    });
  });

  it("understands the scp-style remote form", async () => {
    expect(await hostFor("git@gitlab.example.org:acme/plugin.git")).toMatchObject({
      repo_host: "gitlab.example.org",
    });
  });

  it("calls a filesystem path local", async () => {
    expect(await hostFor("/srv/plugins/acme")).toMatchObject({ repo_host: "local" });
  });

  it("calls anything else unknown", async () => {
    expect(await hostFor("acme-plugin")).toMatchObject({ repo_host: "unknown" });
  });
});
