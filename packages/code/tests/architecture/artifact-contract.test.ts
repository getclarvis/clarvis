import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assertDetachedSourceMaps,
  assertInstallArtifact,
  assertLazyProviderArtifact,
  assertLazySurfaceArtifact,
  assertRelocatableArtifact,
} from "../../tooling/artifact/contract.ts";

const lazyEntry = `async function load() {
  await import("./chunk-provider123.js");
}`;
const providerChunk = {
  path: "chunk-provider123.js",
  source: 'const event = "llm.provider.resolved";',
};

test("the artifact contract accepts a provider adapter behind a generated chunk", () => {
  expect(() =>
    assertLazyProviderArtifact({
      entrySource: lazyEntry,
      javascriptChunks: [providerChunk],
    }),
  ).not.toThrow();
});

test("the artifact contract accepts a Windows path for the generated provider chunk", () => {
  expect(() =>
    assertLazyProviderArtifact({
      entrySource: lazyEntry,
      javascriptChunks: [
        {
          ...providerChunk,
          path: String.raw`D:\a\clarvis\clarvis\packages\code\dist\chunk-provider123.js`,
        },
      ],
    }),
  ).not.toThrow();
});

test("the artifact contract rejects a monolithic entrypoint", () => {
  expect(() =>
    assertLazyProviderArtifact({
      entrySource: "const adapter = new AiSdkAdapter()",
      javascriptChunks: [],
    }),
  ).toThrow("artifact has no lazy JavaScript chunks");
  expect(() =>
    assertLazyProviderArtifact({
      entrySource: 'const event = "llm.provider.resolved";',
      javascriptChunks: [providerChunk],
    }),
  ).toThrow("artifact loads AiSdkAdapter eagerly");
  expect(() =>
    assertLazyProviderArtifact({
      entrySource: "const boot = true",
      javascriptChunks: [providerChunk],
    }),
  ).toThrow("artifact has no dynamic import");
  expect(() =>
    assertLazyProviderArtifact({
      entrySource:
        'import { AiSdkAdapter } from "./chunk-provider123.js"; await import("./chunk-provider123.js");',
      javascriptChunks: [providerChunk],
    }),
  ).toThrow("artifact statically imports");
});

test("cold full-page and floating surfaces remain in lazy chunks", () => {
  const javascriptChunks = [
    { path: "chunk-diff.js", source: 'text: "no diff in the transcript yet"' },
    { path: "chunk-plan.js", source: 'text: "no plan yet"' },
    { path: "chunk-providers.js", source: 'title: "Unverified entitlement"' },
    { path: "chunk-sessions.js", source: 'text: "no sessions yet"' },
    { path: "chunk-workflows.js", source: 'text: "no workflows yet"' },
    { path: "chunk-storage.js", source: 'purpose: "Clarvis-owned local files"' },
    { path: "chunk-doctor.js", source: 'title: "Clarvis Doctor"' },
    { path: "chunk-isolation.js", source: 'title: "Select isolation"' },
    { path: "chunk-review.js", source: 'title: "Select command review"' },
  ];
  expect(() =>
    assertLazySurfaceArtifact({ entrySource: "const boot = true", javascriptChunks }),
  ).not.toThrow();
  expect(() =>
    assertLazySurfaceArtifact({
      entrySource: 'text: "no plan yet"',
      javascriptChunks,
    }),
  ).toThrow('artifact loads the surface containing "no plan yet" eagerly');
  expect(() =>
    assertLazySurfaceArtifact({
      entrySource: "const boot = true",
      javascriptChunks: javascriptChunks.slice(0, 1),
    }),
  ).toThrow('artifact has no lazy surface chunk containing "no plan yet"');
});

test("source maps are retained away from runtime JavaScript", () => {
  expect(() =>
    assertDetachedSourceMaps({
      adjacentMapPaths: [],
      detachedMapPaths: ["index.js.map", "chunk-provider123.js.map"],
    }),
  ).not.toThrow();
  expect(() =>
    assertDetachedSourceMaps({
      adjacentMapPaths: ["index.js.map"],
      detachedMapPaths: ["index.js.map"],
    }),
  ).toThrow("source maps must not sit beside runtime JavaScript");
  expect(() => assertDetachedSourceMaps({ adjacentMapPaths: [], detachedMapPaths: [] })).toThrow(
    "artifact must retain its entrypoint source map",
  );
});

test("the installed artifact contains no source maps", () => {
  expect(() =>
    assertInstallArtifact({
      artifactPaths: ["dist/index.js", "dist/chunk-provider123.js", "dist/models-dev.json"],
    }),
  ).not.toThrow();
  expect(() => assertInstallArtifact({ artifactPaths: ["dist/maps/index.js.map"] })).toThrow(
    "installed artifact must not contain source maps",
  );
  expect(() =>
    assertInstallArtifact({
      artifactPaths: ["dist/index.js"],
      javascriptArtifacts: [
        {
          path: "dist/index.js",
          source: "//# sourceMappingURL=data:application/json;base64,e30=",
        },
      ],
    }),
  ).toThrow("installed artifact must not contain inline source maps");
});

test("generated JavaScript contains no build-host checkout path", () => {
  expect(() =>
    assertRelocatableArtifact({
      buildRoot: "/home/builder/clarvis",
      javascriptArtifacts: [{ path: "dist/index.js", source: 'const root = "clarvis";' }],
    }),
  ).not.toThrow();
  expect(() =>
    assertRelocatableArtifact({
      buildRoot: "/home/builder/clarvis",
      javascriptArtifacts: [
        {
          path: "dist/chunk-pino.js",
          source: 'var __dirname = "/home/builder/clarvis/node_modules/pino";',
        },
      ],
    }),
  ).toThrow("artifact embeds the build-host path: dist/chunk-pino.js");
  expect(() =>
    assertRelocatableArtifact({
      buildRoot: String.raw`D:\a\clarvis\clarvis`,
      javascriptArtifacts: [
        {
          path: String.raw`dist\chunk-pino.js`,
          source: String.raw`var __dirname = "D:\\a\\clarvis\\clarvis\\node_modules\\pino";`,
        },
      ],
    }),
  ).toThrow(String.raw`artifact embeds the build-host path: dist\chunk-pino.js`);
});

test("portable packaging and installation pin archive commands to the C locale", () => {
  const packager = readFileSync(
    new URL("../../tooling/release/package.ts", import.meta.url),
    "utf8",
  );
  const archiveBody = packager.slice(
    packager.indexOf("async function createArchive"),
    packager.indexOf("async function main"),
  );
  expect(archiveBody).toContain('env: { ...process.env, LC_ALL: "C" }');

  const installer = readFileSync(new URL("../../../../install.sh", import.meta.url), "utf8");
  expect(installer).toContain(
    'expected=$(LC_ALL=C awk -v asset="$asset" \'$2 == asset { print $1 }\' "$checksums")',
  );
  expect(installer).toContain(
    "actual=$(LC_ALL=C sha256sum \"$archive\" | LC_ALL=C awk '{ print $1 }')",
  );
  expect(installer).toContain(
    "actual=$(LC_ALL=C shasum -a 256 \"$archive\" | LC_ALL=C awk '{ print $1 }')",
  );
  expect(installer).toContain('LC_ALL=C tar -xzf "$archive" -C "$temporary/extract"');

  const smoke = readFileSync(new URL("../../tooling/release/smoke.ts", import.meta.url), "utf8");
  expect(smoke).toContain("observed the complete-app marker after");
  expect(smoke).not.toContain("reached first paint in");
});

test("portable installers remain independent of container engines", () => {
  const installers = [
    readFileSync(new URL("../../../../install.sh", import.meta.url), "utf8"),
    readFileSync(new URL("../../../../install.ps1", import.meta.url), "utf8"),
  ];
  for (const installer of installers) {
    expect(installer.toLowerCase()).not.toContain("docker");
    expect(installer.toLowerCase()).not.toContain("podman");
  }
});
