import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClarvisContainerRelease } from "../../src/adapters/runtime-image.ts";

const revision = "a".repeat(40);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function target(name: "linux-x64" | "linux-arm64", marker: string) {
  return {
    base: {
      image: "ghcr.io/getclarvis/clarvis-runtime-base",
      digest: `sha256:${marker.repeat(64)}`,
      abi: "clarvis-linux-glibc-v1",
    },
    artifact: {
      asset: `clarvis-kernel-${name}.tar.gz`,
      sha256: (marker === "b" ? "d" : "e").repeat(64),
      size: 1024,
    },
    kernel_wire_version: 11,
    broker_version: 1,
    channel_version: 1,
  };
}

function runtime() {
  return {
    schema_version: 2,
    version: "1.2.3",
    source_revision: revision,
    targets: {
      "linux-x64": target("linux-x64", "b"),
      "linux-arm64": target("linux-arm64", "c"),
    },
  };
}

const responseFetch = (response: () => Response): typeof fetch =>
  (async () => response()) as unknown as typeof fetch;

test("stable release resolves the immutable base and separate Kernel artifact", async () => {
  for (const selectedTarget of ["linux-x64", "linux-arm64"] as const) {
    const selection = await resolveClarvisContainerRelease({
      currentVersion: "1.2.3",
      target: selectedTarget,
      environment: {},
      fetcher: responseFetch(() => new Response(JSON.stringify(runtime()))),
    });
    expect(selection).toEqual({
      base: {
        reference: `ghcr.io/getclarvis/clarvis-runtime-base@sha256:${selectedTarget === "linux-x64" ? "b".repeat(64) : "c".repeat(64)}`,
        pull: true,
      },
      artifact: {
        source: {
          kind: "release",
          repository: "getclarvis/clarvis-releases",
          tag: "v1.2.3",
          assetName: `clarvis-kernel-${selectedTarget}.tar.gz`,
        },
        selection: {
          productVersion: "1.2.3",
          sourceRevision: revision,
          target: selectedTarget,
          baseAbi: "clarvis-linux-glibc-v1",
          digest: `sha256:${selectedTarget === "linux-x64" ? "d".repeat(64) : "e".repeat(64)}`,
          size: 1024,
        },
      },
    });
  }
});

test("candidate selection is tied to its source revision and source repository", async () => {
  const tag = "v1.2.3-rc.4";
  const candidate = {
    schema: 1,
    channel: "candidate",
    installation: "source-v1",
    tag,
    version: "1.2.3",
    source_revision: revision,
    repository: "getclarvis/clarvis",
    kernel_wire_version: 11,
    broker_version: 1,
    channel_version: 1,
    targets: ["linux-x64", "linux-arm64"],
    runtime: runtime(),
  };
  const selection = await resolveClarvisContainerRelease({
    currentVersion: "1.2.3",
    target: "linux-x64",
    environment: {
      CLARVIS_RUNTIME_CANDIDATE: tag,
      CLARVIS_RUNTIME_CANDIDATE_REVISION: revision,
    },
    fetcher: responseFetch(() => new Response(JSON.stringify(candidate))),
  });
  expect(selection.artifact.source).toEqual({
    kind: "release",
    repository: "getclarvis/clarvis",
    tag,
    assetName: "clarvis-kernel-linux-x64.tar.gz",
  });
  await expect(
    resolveClarvisContainerRelease({
      currentVersion: "1.2.3",
      target: "linux-x64",
      environment: {
        CLARVIS_RUNTIME_CANDIDATE: tag,
        CLARVIS_RUNTIME_CANDIDATE_REVISION: "f".repeat(40),
      },
      fetcher: responseFetch(() => new Response(JSON.stringify(candidate))),
    }),
  ).rejects.toThrow("candidate source revision is invalid");
});

test("source mode validates an explicit local archive without consulting a release", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-code-runtime-artifact-"));
  roots.push(root);
  const stage = join(root, "stage");
  const archive = join(root, "clarvis-kernel-linux-x64.tar.gz");
  await mkdir(stage);
  await writeFile(
    join(stage, "manifest.json"),
    JSON.stringify({ productVersion: "1.2.3", sourceRevision: revision, target: "linux-x64" }),
  );
  const tar = Bun.spawn(["tar", "-czf", archive, "-C", stage, "manifest.json"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await tar.exited).toBe(0);
  const selection = await resolveClarvisContainerRelease({
    currentVersion: "1.2.3",
    target: "linux-x64",
    environment: {
      CLARVIS_CODE_SOURCE: "1",
      CLARVIS_RUNTIME_BASE: "clarvis-base:local",
      CLARVIS_RUNTIME_ARTIFACT: archive,
    },
    fetcher: responseFetch(() => {
      throw new Error("source mode must not fetch");
    }),
  });
  expect(selection.base).toEqual({ reference: "clarvis-base:local", pull: false });
  expect(selection.artifact.source).toEqual({ kind: "local", archivePath: archive });
  expect(selection.artifact.selection).toMatchObject({
    productVersion: "1.2.3",
    sourceRevision: revision,
    target: "linux-x64",
    baseAbi: "clarvis-linux-glibc-v1",
  });
  await expect(
    resolveClarvisContainerRelease({
      currentVersion: "1.2.4",
      target: "linux-x64",
      environment: {
        CLARVIS_CODE_SOURCE: "1",
        CLARVIS_RUNTIME_BASE: "clarvis-base:local",
        CLARVIS_RUNTIME_ARTIFACT: archive,
      },
    }),
  ).rejects.toThrow("local Container artifact identity is invalid");
});

test("release acquisition rejects incomplete identities, untrusted redirects and oversized bodies", async () => {
  await expect(
    resolveClarvisContainerRelease({
      currentVersion: "dev",
      target: "linux-x64",
      environment: {},
    }),
  ).rejects.toThrow("version cannot select");
  await expect(
    resolveClarvisContainerRelease({
      currentVersion: "1.2.3",
      target: "linux-x64",
      environment: { CLARVIS_CODE_SOURCE: "1" },
    }),
  ).rejects.toThrow("requires explicit");
  await expect(
    resolveClarvisContainerRelease({
      currentVersion: "1.2.3",
      target: "linux-x64",
      environment: {},
      fetcher: responseFetch(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://invalid.example/runtime-release.json" },
          }),
      ),
    }),
  ).rejects.toThrow("destination is untrusted");
  await expect(
    resolveClarvisContainerRelease({
      currentVersion: "1.2.3",
      target: "linux-x64",
      environment: {},
      fetcher: responseFetch(() => new Response("x".repeat(64 * 1024 + 1))),
    }),
  ).rejects.toThrow("size limit");
  await expect(
    resolveClarvisContainerRelease({
      currentVersion: "1.2.3",
      target: "linux-x64",
      environment: {},
      fetcher: responseFetch(
        () => new Response(JSON.stringify({ ...runtime(), schema_version: 1 })),
      ),
    }),
  ).rejects.toThrow("manifest identity is invalid");
  await expect(
    resolveClarvisContainerRelease({
      currentVersion: "1.2.3",
      target: "linux-x64",
      environment: {},
      fetcher: responseFetch(() => new Response(JSON.stringify({ ...runtime(), extra: true }))),
    }),
  ).rejects.toThrow("manifest identity is invalid");
  const badTarget = runtime();
  badTarget.targets["linux-x64"].broker_version = 2;
  await expect(
    resolveClarvisContainerRelease({
      currentVersion: "1.2.3",
      target: "linux-x64",
      environment: {},
      fetcher: responseFetch(() => new Response(JSON.stringify(badTarget))),
    }),
  ).rejects.toThrow("target identity is invalid");
});
