import { expect, test } from "bun:test";

import {
  compareProductVersions,
  parseProductVersion,
  releaseAssetName,
  releaseRuntimeExecutableName,
  releaseTarget,
  selectUpdateRelease,
  type ReleaseAsset,
  type ReleaseRecord,
  type ReleaseTarget,
} from "../../src/update-contract.ts";

function asset(
  version: string,
  target: ReleaseTarget,
  over: Partial<ReleaseAsset> = {},
): ReleaseAsset {
  const tagName = `v${version}`;
  const name = releaseAssetName(version, target);
  return {
    name,
    size: 1024,
    digest: `sha256:${"a".repeat(64)}`,
    state: "uploaded",
    browserDownloadUrl: `https://github.com/getclarvis/clarvis-releases/releases/download/${tagName}/${name}`,
    ...over,
  };
}

function release(
  version: string,
  target: ReleaseTarget,
  over: Partial<ReleaseRecord> = {},
): ReleaseRecord {
  return {
    tagName: `v${version}`,
    draft: false,
    prerelease: version.includes("-"),
    publishedAt: "2026-08-25T00:00:00Z",
    assets: [asset(version, target)],
    ...over,
  };
}

test("product versions parse and compare with SemVer prerelease precedence", () => {
  expect(parseProductVersion("0.0.1-beta")).toMatchObject({ major: 0, minor: 0, patch: 1 });
  expect(parseProductVersion("1.2.3-beta.01")).toBeUndefined();
  expect(parseProductVersion("01.2.3")).toBeUndefined();
  expect(compareProductVersions("0.0.1-beta", "0.0.1-beta.1")).toBeLessThan(0);
  expect(compareProductVersions("0.0.1-beta.2", "0.0.1-beta.10")).toBeLessThan(0);
  expect(compareProductVersions("0.0.1-rc.1", "0.0.1")).toBeLessThan(0);
  expect(compareProductVersions("0.0.2-beta", "0.0.1")).toBeGreaterThan(0);
});

test("native target and archive names are strict and portable", () => {
  expect(releaseTarget("linux", "x64")).toBe("linux-x64");
  expect(releaseTarget("darwin", "arm64")).toBe("darwin-arm64");
  expect(releaseTarget("win32", "x64")).toBe("windows-x64");
  expect(releaseTarget("freebsd", "x64")).toBeUndefined();
  expect(releaseTarget("linux", "ia32")).toBeUndefined();
  expect(releaseAssetName("0.0.1-beta", "windows-x64")).toBe(
    "clarvis-v0.0.1-beta-windows-x64.tar.gz",
  );
  expect(releaseRuntimeExecutableName("linux")).toBe("clarvis");
  expect(releaseRuntimeExecutableName("darwin")).toBe("clarvis");
  expect(releaseRuntimeExecutableName("win32")).toBe("clarvis.exe");
});

test("beta installs select the highest beta, rc, or stable promotion", () => {
  const target = "linux-x64";
  const selected = selectUpdateRelease("0.0.1-beta", target, [
    release("0.0.1-beta.2", target),
    release("0.0.1", target),
    release("0.0.2-beta", target),
  ]);
  expect(selected?.version).toBe("0.0.2-beta");
});

test("stable installs ignore prereleases and never downgrade or reinstall", () => {
  const target = "linux-x64";
  expect(
    selectUpdateRelease("1.0.0", target, [
      release("1.1.0-beta", target),
      release("1.0.0", target),
      release("0.9.9", target),
    ]),
  ).toBeUndefined();
  expect(selectUpdateRelease("1.0.0", target, [release("1.0.1", target)])?.version).toBe("1.0.1");
});

test("drafts and assets with ambiguous identity or integrity are ineligible", () => {
  const target = "linux-x64";
  const version = "0.0.2-beta";
  const valid = asset(version, target);
  for (const candidate of [
    release(version, target, { draft: true }),
    release(version, target, { tagName: "release-0.0.2-beta" }),
    release(version, target, { prerelease: false }),
    release(version, target, { assets: [{ ...valid, digest: "sha256:no" }] }),
    release(version, target, { assets: [{ ...valid, size: 0 }] }),
    release(version, target, {
      assets: [{ ...valid, browserDownloadUrl: "https://example.com/clarvis.tar.gz" }],
    }),
    release(version, target, { assets: [valid, valid] }),
  ]) {
    expect(selectUpdateRelease("0.0.1-beta", target, [candidate])).toBeUndefined();
  }
});
