import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateRuntimeGit } from "../../src/index.ts";
import type { ProcessRunner, ProcessRunRequest } from "../../src/ports/process-runner.ts";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("private runtime Git metadata", () => {
  it("constructs history without alternates, remotes, helpers, or hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-private-git-"));
    directories.push(root);
    const source = join(root, "source");
    const retained = join(root, "retained");
    await mkdir(source);
    await mkdir(retained);
    const requests: ProcessRunRequest[] = [];
    const runner: ProcessRunner = {
      async run(request) {
        requests.push(request);
        const args = request.args;
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: "true\n", stderr: "" };
        if (args[0] === "symbolic-ref" && args[1] === "-q") {
          return { exitCode: 0, stdout: "refs/heads/main\n", stderr: "" };
        }
        if (args[0] === "for-each-ref") {
          return { exitCode: 0, stdout: "refs/heads/main\nrefs/tags/v1\n", stderr: "" };
        }
        if (args[0] === "init") await mkdir(join(retained, ".git"), { recursive: true });
        if (args[0] === "bundle") await writeFile(String(args[2]), "portable objects");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await mkdir(join(source, ".git"));

    await expect(createPrivateRuntimeGit(source, retained, runner)).resolves.toBe(true);
    expect(requests.map((request) => request.args[0])).toEqual([
      "rev-parse",
      "symbolic-ref",
      "for-each-ref",
      "init",
      "config",
      "config",
      "bundle",
      "fetch",
      "symbolic-ref",
      "read-tree",
    ]);
    expect(requests.find((request) => request.args[0] === "init")?.args).toContain("--template=");
    expect(requests.find((request) => request.args[0] === "fetch")?.args.join(" ")).not.toContain(
      "alternates",
    );
    expect(requests.every((request) => request.environment.GIT_CONFIG_NOSYSTEM === "1")).toBe(true);
    await expect(readFile(join(retained, ".git", "clarvis-history.bundle"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does nothing for a non-Git source", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-private-git-"));
    directories.push(root);
    const source = join(root, "source");
    const retained = join(root, "retained");
    await mkdir(source);
    await mkdir(retained);
    let calls = 0;
    await expect(
      createPrivateRuntimeGit(source, retained, {
        async run() {
          calls += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).resolves.toBe(false);
    expect(calls).toBe(0);
  });
});
