import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeProcessRunner } from "../../src/local.ts";
import { createGitPluginFetcher } from "../../src/adapters/git/plugin-fetcher.ts";
import type { ProcessRunner } from "../../src/ports/process-runner.ts";
import { recordingLogger } from "../helpers/logger.ts";

describe("local.process.failed", () => {
  it("enforces a combined UTF-8 output ceiling without disclosing child output", async () => {
    const logger = recordingLogger();
    const runner = createNodeProcessRunner(logger);
    await expect(
      runner.run({
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write('private'.repeat(100)); process.stderr.write('private'.repeat(100))",
        ],
        environment: {},
        maxOutputBytes: 100,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("admitted limit");
    expect(JSON.stringify(logger.records)).not.toContain("private");
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
      environment: {},
      maxOutputBytes: 2,
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "ok" });
  });
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

  it("installs an npm package without lifecycle scripts and preserves its dependencies", async () => {
    const globalDir = mkdtempSync(join(tmpdir(), "clarvis-npm-plugin-"));
    const requests: Parameters<ProcessRunner["run"]>[0][] = [];
    const signal = new AbortController().signal;
    const processRunner: ProcessRunner = {
      async run(request) {
        requests.push(request);
        const prefixIndex = request.args.indexOf("--prefix");
        const staging = request.args[prefixIndex + 1];
        if (staging === undefined) throw new Error("missing npm prefix");
        const packageRoot = join(staging, "node_modules", "@acme", "reviewkit");
        mkdirSync(join(packageRoot, "nested"), { recursive: true });
        writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version: "2.4.1" }));
        writeFileSync(join(packageRoot, "nested", "asset.txt"), "asset");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const fetcher = createGitPluginFetcher({
      globalDir,
      processRunner,
      environment: { PATH: "/bin" },
    });

    try {
      const fetchNpm = fetcher.fetchNpm?.bind(fetcher);
      if (fetchNpm === undefined) throw new Error("Git plugin fetcher must support npm");
      const prepared = await fetchNpm(
        "@acme/reviewkit",
        "^2.0.0",
        "https://registry.example.test",
        signal,
      );
      expect(prepared).toMatchObject({
        origin: "npm:@acme/reviewkit@^2.0.0",
        revision: "2.4.1",
      });
      expect(existsSync(join(prepared.root, "package.json"))).toBe(true);
      expect(existsSync(join(prepared.root, "nested", "asset.txt"))).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        command: "npm",
        environment: { PATH: "/bin" },
        signal,
      });
      expect(requests[0]?.args).toEqual(
        expect.arrayContaining([
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--registry",
          "https://registry.example.test",
          "@acme/reviewkit@^2.0.0",
        ]),
      );
      await prepared.dispose();
      expect(existsSync(prepared.root)).toBe(false);
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it("cleans npm staging after install failure or a missing package", async () => {
    const globalDir = mkdtempSync(join(tmpdir(), "clarvis-npm-plugin-failure-"));
    try {
      const failed = createGitPluginFetcher({
        globalDir,
        processRunner: {
          async run() {
            return { exitCode: 1, stdout: "", stderr: "registry refused package\n" };
          },
        },
        environment: {},
      });
      const fetchFailedNpm = failed.fetchNpm?.bind(failed);
      if (fetchFailedNpm === undefined) throw new Error("Git plugin fetcher must support npm");
      await expect(fetchFailedNpm("reviewkit", undefined, undefined, undefined)).rejects.toThrow(
        "npm install failed: registry refused package",
      );

      const missing = createGitPluginFetcher({
        globalDir,
        processRunner: {
          async run() {
            return { exitCode: 0, stdout: "installed", stderr: "" };
          },
        },
        environment: {},
      });
      const fetchMissingNpm = missing.fetchNpm?.bind(missing);
      if (fetchMissingNpm === undefined) throw new Error("Git plugin fetcher must support npm");
      await expect(fetchMissingNpm("reviewkit", "1.0.0", undefined, undefined)).rejects.toThrow(
        "npm did not install 'reviewkit'",
      );
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous or unsafe git selectors before spawning", async () => {
    const globalDir = mkdtempSync(join(tmpdir(), "clarvis-git-selector-"));
    let spawned = false;
    const fetcher = createGitPluginFetcher({
      globalDir,
      processRunner: {
        async run() {
          spawned = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      environment: {},
    });
    try {
      await expect(
        fetcher.fetch("https://example.test/plugin.git", undefined, undefined, {
          ref: "main",
          sha: "a".repeat(40),
        }),
      ).rejects.toThrow("cannot declare both ref and sha");
      await expect(
        fetcher.fetch("https://example.test/plugin.git", undefined, undefined, {
          ref: "../outside",
        }),
      ).rejects.toThrow("invalid plugin git ref");
      await expect(
        fetcher.fetch("https://example.test/plugin.git", undefined, undefined, { sha: "short" }),
      ).rejects.toThrow("invalid plugin git sha");
      expect(spawned).toBe(false);
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
  });
});
