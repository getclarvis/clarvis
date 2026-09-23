import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  candidateJson,
  installCandidate,
  selectCandidateRelease,
} from "../../tooling/candidate-install.ts";
import { parseRuntimeCandidate } from "../../src/adapters/runtime-candidate.ts";
import { productVersion } from "../../src/cli-args.ts";
import { productRootForEntry } from "../../src/cli-entry.ts";
import { CLARVIS_DOCS_FIRST_VERSION } from "../../src/update/release-manifest.ts";

const version = productVersion();
const tag = `v${version}-rc.4`;
const revision = "a".repeat(40);
const target = (name: "linux-x64" | "linux-arm64", hash: string) =>
  ({
    base: {
      image: "ghcr.io/getclarvis/clarvis-base",
      digest: `sha256:${hash.repeat(64)}`,
      abi: "clarvis-linux-glibc-v1",
    },
    artifact: {
      asset: `clarvis-kernel-${name}.tar.gz`,
      sha256: (hash === "b" ? "d" : "e").repeat(64),
      size: 1024,
    },
    kernel_wire_version: 11,
    broker_version: 1,
    channel_version: 1,
  }) as const;
const runtime = {
  schema_version: 2,
  version,
  source_revision: revision,
  targets: { "linux-x64": target("linux-x64", "b"), "linux-arm64": target("linux-arm64", "c") },
} as const;
const candidate = {
  schema: 1,
  channel: "candidate",
  installation: "source-v1",
  tag,
  version,
  source_revision: revision,
  repository: "getclarvis/clarvis",
  kernel_wire_version: 11,
  broker_version: 1,
  channel_version: 1,
  targets: ["linux-x64", "linux-arm64"],
  runtime,
} as const;

test("candidate identity embeds the schema-2 base/artifact map without prefetching an image", () => {
  expect(parseRuntimeCandidate(candidate, tag)).toEqual(candidate);
  for (const invalid of [
    { ...candidate, runtime: { ...runtime, schema_version: 1 } },
    { ...candidate, broker_version: 2 },
    { ...candidate, targets: ["linux-x64"] },
  ])
    expect(() => parseRuntimeCandidate(invalid, tag)).toThrow();
});

test("candidate selection requires an exact published sidecar and compares RC numbers numerically", () => {
  const release = (name: string, sidecar = true) => ({
    tag_name: name,
    draft: false,
    prerelease: true,
    assets: sidecar ? [{ name: "runtime-candidate.json" }] : [],
  });
  expect(selectCandidateRelease([release(`v${version}-rc.2`), release(tag)])).toBe(tag);
  expect(() => selectCandidateRelease([release(tag, false)])).toThrow();
});

test("candidate metadata bounds bodies and refuses a foreign final origin", async () => {
  const foreign = new Response("{}");
  Object.defineProperty(foreign, "url", { value: "https://invalid.example/manifest" });
  await expect(
    candidateJson("https://github.com/getclarvis/clarvis", async () => foreign),
  ).rejects.toThrow("outside GitHub");
  await expect(
    candidateJson(
      "https://github.com/getclarvis/clarvis",
      async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    ),
  ).rejects.toThrow("size limit");
});

test("candidate installation publishes only its selected checkout and retires a pre-skill candidate", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-candidate-docs-"));
  const sourceRoot = productRootForEntry(
    fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
  );
  const sourceDocs = join(
    sourceRoot,
    "packages",
    "kernel",
    "assets",
    "skills",
    ".system",
    "clarvis-docs",
  );
  const globalDir = join(root, "global");
  const versionParts = CLARVIS_DOCS_FIRST_VERSION.split(".").map(Number);
  const [major, minor, patch] = versionParts;
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error("test needs a representable pre-skill stable version");
  }
  const olderVersion =
    patch > 0
      ? `${String(major)}.${String(minor)}.${String(patch - 1)}`
      : minor > 0
        ? `${String(major)}.${String(minor - 1)}.0`
        : major > 0
          ? `${String(major - 1)}.0.0`
          : undefined;
  if (olderVersion === undefined) throw new Error("first skill version has no predecessor");
  const makeManifest = (selectedVersion: string) => {
    const selectedTag = `v${selectedVersion}-rc.4`;
    return {
      ...candidate,
      tag: selectedTag,
      version: selectedVersion,
      runtime: { ...runtime, version: selectedVersion },
    };
  };
  const install = async (selectedVersion: string, withDocs: boolean) => {
    const manifest = makeManifest(selectedVersion);
    return installCandidate({
      tag: manifest.tag,
      installRoot: join(root, "candidates"),
      binDirectory: join(root, "bin"),
      bun: process.execPath,
      bunVersion: Bun.version,
      globalDir,
      fetcher: async (input) =>
        new Response(
          JSON.stringify(
            String(input).endsWith("runtime-candidate.json")
              ? manifest
              : {
                  tag_name: manifest.tag,
                  draft: false,
                  prerelease: true,
                  assets: [{ name: "runtime-candidate.json" }],
                },
          ),
        ),
      run: (argv, cwd) => {
        if (argv[0] === "git" && argv[1] === "rev-parse") return revision;
        if (argv[0] === "git" && argv[1] === "checkout") {
          mkdirSync(join(cwd, "packages", "code", "src"), { recursive: true });
          writeFileSync(join(cwd, "package.json"), JSON.stringify({ version: selectedVersion }));
          writeFileSync(join(cwd, "mise.toml"), `bun = "${Bun.version}"\n`);
          writeFileSync(join(cwd, "packages", "code", "src", "cli.ts"), "");
          if (withDocs) {
            const destination = join(
              cwd,
              "packages",
              "kernel",
              "assets",
              "skills",
              ".system",
              "clarvis-docs",
            );
            mkdirSync(dirname(destination), { recursive: true });
            cpSync(sourceDocs, destination, { recursive: true });
          }
        }
        if (argv[0] === process.execPath && argv[1] === "packages/code/src/cli.ts") {
          return `clarvis ${selectedVersion}`;
        }
        return "";
      },
    });
  };
  try {
    const first = await install(version, true);
    const installed = join(globalDir, "skills", ".system", "clarvis-docs", "SKILL.md");
    expect(readFileSync(installed, "utf8")).toBe(
      readFileSync(join(sourceDocs, "SKILL.md"), "utf8"),
    );
    expect(first.checkout).toContain(first.manifest.tag);
    const older = await install(olderVersion, false);
    expect(existsSync(installed)).toBe(false);
    expect(older.checkout).toContain(older.manifest.tag);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
