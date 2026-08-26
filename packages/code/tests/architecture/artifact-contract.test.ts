import { expect, test } from "bun:test";
import {
  assertDetachedSourceMaps,
  assertInstallArtifact,
  assertLazyProviderArtifact,
  assertLazySurfaceArtifact,
} from "../../tooling/artifact/contract.ts";

const lazyEntry = `async function load() {
  await import("./chunk-provider123.js");
}`;
const providerChunk = {
  path: "chunk-provider123.js",
  source: "class AiSdkAdapter {}\nexport { AiSdkAdapter };",
};

test("the artifact contract accepts a provider adapter behind a generated chunk", () => {
  expect(() =>
    assertLazyProviderArtifact({
      entrySource: lazyEntry,
      javascriptChunks: [providerChunk],
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
      entrySource: "class AiSdkAdapter {}",
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
    { path: "chunk-plan.js", source: 'text: "no plans yet"' },
    { path: "chunk-providers.js", source: 'title: "Unverified entitlement"' },
    { path: "chunk-sessions.js", source: 'text: "no sessions yet"' },
    { path: "chunk-workflows.js", source: 'text: "no workflows yet"' },
    { path: "chunk-storage.js", source: 'purpose: "Clarvis-owned local files"' },
    { path: "chunk-doctor.js", source: 'title: "Clarvis Doctor"' },
    { path: "chunk-safety.js", source: 'title: "Select safety preset"' },
  ];
  expect(() =>
    assertLazySurfaceArtifact({ entrySource: "const boot = true", javascriptChunks }),
  ).not.toThrow();
  expect(() =>
    assertLazySurfaceArtifact({
      entrySource: 'text: "no plans yet"',
      javascriptChunks,
    }),
  ).toThrow('artifact loads the surface containing "no plans yet" eagerly');
  expect(() =>
    assertLazySurfaceArtifact({
      entrySource: "const boot = true",
      javascriptChunks: javascriptChunks.slice(0, 1),
    }),
  ).toThrow('artifact has no lazy surface chunk containing "no plans yet"');
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
});
