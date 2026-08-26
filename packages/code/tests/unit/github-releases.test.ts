import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { downloadReleaseAsset, fetchReleaseRecords } from "../../src/update/github-releases.ts";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("the GitHub release index is bounded and decoded to the policy shape", async () => {
  let redirect: RequestInit["redirect"];
  const releases = await fetchReleaseRecords((_input, init) => {
    redirect = init?.redirect;
    return Promise.resolve(
      jsonResponse([
        {
          tag_name: "v0.0.2-beta",
          draft: false,
          prerelease: true,
          published_at: "2026-08-25T00:00:00Z",
          assets: [
            {
              name: "clarvis-v0.0.2-beta-linux-x64.tar.gz",
              size: 42,
              digest: `sha256:${"a".repeat(64)}`,
              state: "uploaded",
              browser_download_url:
                "https://github.com/getclarvis/clarvis/releases/download/v0.0.2-beta/clarvis-v0.0.2-beta-linux-x64.tar.gz",
            },
          ],
        },
      ]),
    );
  }, "clarvis/0.0.1-beta");
  expect(redirect).toBe("error");
  expect(releases).toHaveLength(1);
  expect(releases[0]?.assets[0]?.size).toBe(42);
});

test("oversized or malformed release indexes fail closed", async () => {
  await expect(
    fetchReleaseRecords(
      () => Promise.resolve(new Response("x".repeat(2 * 1024 * 1024 + 1))),
      "clarvis/test",
    ),
  ).rejects.toThrow("exceeds");
  await expect(
    fetchReleaseRecords(() => Promise.resolve(jsonResponse({ releases: [] })), "clarvis/test"),
  ).rejects.toThrow("shape");
});

test("asset download verifies exact bytes, size and SHA-256", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-release-download-"));
  const destination = join(root, "asset.tar.gz");
  const bytes = new TextEncoder().encode("portable-release");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const asset = {
    name: "clarvis-v0.0.2-beta-linux-x64.tar.gz",
    size: bytes.byteLength,
    digest: `sha256:${digest}`,
    state: "uploaded" as const,
    browserDownloadUrl:
      "https://github.com/getclarvis/clarvis/releases/download/v0.0.2-beta/clarvis-v0.0.2-beta-linux-x64.tar.gz",
  };
  try {
    await downloadReleaseAsset(
      () =>
        Promise.resolve(
          new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } }),
        ),
      asset,
      destination,
      "clarvis/test",
    );
    expect(await readFile(destination)).toEqual(Buffer.from(bytes));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("asset download rejects truncation and digest mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-release-download-bad-"));
  const base = {
    name: "clarvis-v0.0.2-beta-linux-x64.tar.gz",
    size: 4,
    digest: `sha256:${"a".repeat(64)}`,
    state: "uploaded" as const,
    browserDownloadUrl:
      "https://github.com/getclarvis/clarvis/releases/download/v0.0.2-beta/clarvis-v0.0.2-beta-linux-x64.tar.gz",
  };
  try {
    await expect(
      downloadReleaseAsset(
        () => Promise.resolve(new Response("abc")),
        base,
        join(root, "truncated"),
        "clarvis/test",
      ),
    ).rejects.toThrow("truncated");
    await expect(
      downloadReleaseAsset(
        () => Promise.resolve(new Response("abcd")),
        base,
        join(root, "mismatch"),
        "clarvis/test",
      ),
    ).rejects.toThrow("checksum");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
