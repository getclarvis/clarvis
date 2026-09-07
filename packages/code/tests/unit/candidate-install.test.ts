import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateJson,
  installCandidate,
  selectCandidateRelease,
} from "../../tooling/candidate-install.ts";
import { parseDevelopmentInstallArgs } from "../../tooling/development-install.ts";
import { parseRuntimeCandidate } from "../../src/adapters/runtime-candidate.ts";

const tag = "v1.2.3-rc.10";
const sha = "a".repeat(40);
function manifest() {
  return {
    schema: 1,
    channel: "candidate",
    installation: "source-v1",
    tag,
    version: "1.2.3",
    source_revision: sha,
    repository: "getclarvis/clarvis",
    protocol_revision: "5",
    platforms: ["linux/amd64", "linux/arm64"],
    artifact_image: `ghcr.io/getclarvis/clarvis-runtime-candidate-artifact@sha256:${"b".repeat(64)}`,
    runtime_image: `ghcr.io/getclarvis/clarvis-runtime-candidate@sha256:${"c".repeat(64)}`,
  };
}
const release = {
  tag_name: tag,
  draft: false,
  prerelease: true,
  assets: [{ name: "runtime-candidate.json" }],
};

test("candidate installation remains explicit and selects published RCs numerically", () => {
  expect(parseDevelopmentInstallArgs(["--candidate"])).toEqual({
    mode: "install",
    clear: false,
    candidate: "latest",
  });
  expect(parseDevelopmentInstallArgs(["--candidate", tag]).candidate).toBe(tag);
  for (const args of [
    ["--candidate", "v1.2.3"],
    ["--candidate", "--clear"],
    ["--candidate", "--uninstall"],
    ["--candidate", "--candidate"],
  ]) {
    expect(() => parseDevelopmentInstallArgs(args)).toThrow();
  }
  expect(
    selectCandidateRelease([
      { ...release, tag_name: "v1.2.3-rc.2" },
      release,
      { ...release, tag_name: "v9.0.0-rc.1", draft: true },
      { ...release, tag_name: "v8.0.0-rc.1", prerelease: false },
      { ...release, tag_name: "v7.0.0-rc.1", assets: [] },
    ]),
  ).toBe(tag);
  expect(() => selectCandidateRelease(release, "v1.2.3-rc.1")).toThrow();
  expect(() => parseRuntimeCandidate({ ...manifest(), installation: undefined }, tag)).toThrow(
    "source-v1",
  );
});

test("candidate metadata refuses off-host redirects, failed downloads, and oversized bodies", async () => {
  for (const response of [
    new Response("error", { status: 404 }),
    new Response("x".repeat(2 * 1024 * 1024 + 1)),
  ]) {
    await expect(
      candidateJson(
        "https://github.com/example",
        (async () => response) as unknown as typeof fetch,
      ),
    ).rejects.toThrow();
  }
  const response = new Response("{}");
  Object.defineProperty(response, "url", { value: "https://evil.example/manifest" });
  await expect(
    candidateJson("https://github.com/example", (async () => response) as unknown as typeof fetch),
  ).rejects.toThrow("outside GitHub");
});

test("candidate installer pins source and image before activation and preserves the old launcher on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-candidate-install-"));
  const installs = join(root, "candidates");
  const bin = join(root, "bin");
  await mkdir(bin);
  const launcher = join(bin, "clarvis-develop");
  const old = "# clarvis-develop managed launcher v1\nold launcher\n";
  await writeFile(launcher, old);
  const calls: string[][] = [];
  let failPull = true;
  let checkout = "";
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("runtime-candidate.json")) return new Response(JSON.stringify(manifest()));
    return new Response(JSON.stringify(release));
  }) as unknown as typeof fetch;
  const run = (argv: readonly string[], cwd: string) => {
    calls.push([...argv]);
    if (argv[1] === "rev-parse") return sha;
    if (argv[1] === "checkout") checkout = cwd;
    if (argv[0] === "docker" && argv[1] === "pull" && failPull)
      throw new Error("registry unavailable");
    if (argv[0] === "docker" && argv[1] === "image") return `sha256:${"d".repeat(64)}`;
    if (argv.includes("--version")) return "clarvis 1.2.3";
    return "";
  };
  try {
    const { writeFileSync } = await import("node:fs");
    const fixtureRun = (argv: readonly string[], cwd: string) => {
      const result = run(argv, cwd);
      if (argv[1] === "checkout") {
        writeFileSync(join(cwd, "package.json"), '{"version":"1.2.3"}');
        writeFileSync(join(cwd, "mise.toml"), 'bun = "1.4.0"');
      }
      return result;
    };
    const input = {
      tag,
      installRoot: installs,
      binDirectory: bin,
      bun: process.execPath,
      bunVersion: "1.4.0",
      fetcher,
      run: fixtureRun,
    };
    await expect(installCandidate(input)).rejects.toThrow("registry unavailable");
    expect(await readFile(launcher, "utf8")).toBe(old);
    expect(await readdir(installs)).toEqual([]);
    failPull = false;
    const installed = await installCandidate(input);
    expect(installed.checkout).toBe(checkout);
    const source = await readFile(launcher, "utf8");
    expect(source).toContain(`CLARVIS_RUNTIME_CANDIDATE='${tag}'`);
    expect(source).toContain(`CLARVIS_RUNTIME_CANDIDATE_REVISION='${sha}'`);
    expect(calls).toContainEqual(["docker", "pull", manifest().runtime_image]);
    expect(calls).toContainEqual(["git", "fetch", "--depth=1", "origin", `refs/tags/${tag}`]);
    expect(calls.some((argv) => argv.includes("--frozen-lockfile"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate installation checks out the published commit with real Git and launches it with Bun", async () => {
  const { spawnSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "clarvis-candidate-git-"));
  const source = join(root, "source");
  await mkdir(source);
  const execute = (argv: readonly string[], cwd: string): string => {
    const executable = argv[0];
    if (executable === undefined) throw new Error("empty fixture command");
    const result = spawnSync(executable, argv.slice(1), { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || String(result.error));
    return result.stdout.trim();
  };
  try {
    execute(["git", "init", "--quiet"], source);
    execute(["git", "config", "user.name", "Candidate Fixture"], source);
    execute(["git", "config", "user.email", "fixture@example.invalid"], source);
    await writeFile(join(source, "package.json"), '{"version":"1.2.3"}');
    await writeFile(join(source, "mise.toml"), `bun = "${Bun.version}"`);
    await mkdir(join(source, "packages/code/src"), { recursive: true });
    await writeFile(
      join(source, "packages/code/src/cli.ts"),
      'process.stdout.write("clarvis 1.2.3\\n");',
    );
    execute(["git", "add", "."], source);
    execute(["git", "-c", "commit.gpgsign=false", "commit", "-m", "candidate fixture"], source);
    execute(["git", "-c", "tag.gpgsign=false", "tag", tag], source);
    const revision = execute(["git", "rev-parse", "HEAD"], source);
    const fetcher = (async (input: string | URL | Request) =>
      new Response(
        JSON.stringify(
          String(input).endsWith("runtime-candidate.json")
            ? { ...manifest(), source_revision: revision }
            : release,
        ),
      )) as unknown as typeof fetch;
    const result = await installCandidate({
      tag,
      installRoot: join(root, "installed"),
      binDirectory: join(root, "bin"),
      bun: process.execPath,
      bunVersion: Bun.version,
      fetcher,
      run: (argv, cwd) => {
        if (argv[0] === "docker") return argv[1] === "image" ? `sha256:${"d".repeat(64)}` : "";
        if (argv[1] === "remote") return execute(["git", "remote", "add", "origin", source], cwd);
        return execute(argv, cwd);
      },
    });
    expect(execute(["git", "rev-parse", "HEAD"], result.checkout)).toBe(revision);
    expect(execute([result.launcher, "--version"], root)).toBe("clarvis 1.2.3");
    expect(await readFile(result.launcher, "utf8")).toContain(revision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
