import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

import {
  MAX_RELEASE_ASSET_BYTES,
  RELEASES_API_URL,
  type ReleaseAsset,
  type ReleaseRecord,
} from "../update-contract.ts";

const MAX_RELEASE_INDEX_BYTES = 2 * 1024 * 1024;
const API_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

/** Minimal Fetch surface required by the release client. */
export type ReleaseFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) throw new Error("release response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`release response exceeds ${String(limit)} bytes`);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeAsset(value: unknown): ReleaseAsset | undefined {
  const asset = record(value);
  if (
    asset === undefined ||
    typeof asset.name !== "string" ||
    typeof asset.size !== "number" ||
    typeof asset.digest !== "string" ||
    asset.state !== "uploaded" ||
    typeof asset.browser_download_url !== "string"
  ) {
    return undefined;
  }
  return {
    name: asset.name,
    size: asset.size,
    digest: asset.digest,
    state: "uploaded",
    browserDownloadUrl: asset.browser_download_url,
  };
}

function decodeRelease(value: unknown): ReleaseRecord | undefined {
  const release = record(value);
  if (
    release === undefined ||
    typeof release.tag_name !== "string" ||
    typeof release.draft !== "boolean" ||
    typeof release.prerelease !== "boolean" ||
    typeof release.published_at !== "string" ||
    !Array.isArray(release.assets) ||
    release.assets.length > 64
  ) {
    return undefined;
  }
  return {
    tagName: release.tag_name,
    draft: release.draft,
    prerelease: release.prerelease,
    publishedAt: release.published_at,
    assets: release.assets.flatMap((asset) => {
      const decoded = decodeAsset(asset);
      return decoded === undefined ? [] : [decoded];
    }),
  };
}

/** Read the bounded public GitHub release index without following API redirects. */
export async function fetchReleaseRecords(
  fetcher: ReleaseFetch,
  userAgent: string,
  apiUrl = RELEASES_API_URL,
): Promise<ReleaseRecord[]> {
  const response = await fetcher(apiUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": userAgent,
    },
  });
  if (!response.ok) throw new Error(`release index failed with HTTP ${String(response.status)}`);
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder().decode(await boundedBytes(response, MAX_RELEASE_INDEX_BYTES)),
    );
  } catch (error) {
    throw new Error(
      `release index is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!Array.isArray(value) || value.length > 30) throw new Error("release index shape is invalid");
  return value.flatMap((release) => {
    const decoded = decodeRelease(release);
    return decoded === undefined ? [] : [decoded];
  });
}

function allowedDownloadUrl(value: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    (url.hostname === "github.com" ||
      url.hostname === "objects.githubusercontent.com" ||
      url.hostname === "release-assets.githubusercontent.com")
  );
}

/** Download one release asset to a newly created file and verify its API digest and size. */
export async function downloadReleaseAsset(
  fetcher: ReleaseFetch,
  asset: ReleaseAsset,
  destination: string,
  userAgent: string,
): Promise<void> {
  if (!allowedDownloadUrl(asset.browserDownloadUrl))
    throw new Error("release asset URL is untrusted");
  if (asset.size <= 0 || asset.size > MAX_RELEASE_ASSET_BYTES) {
    throw new Error("release asset size is outside the accepted bound");
  }
  const response = await fetcher(asset.browserDownloadUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { accept: "application/octet-stream", "user-agent": userAgent },
  });
  if (!response.ok) throw new Error(`release download failed with HTTP ${String(response.status)}`);
  if (!allowedDownloadUrl(response.url || asset.browserDownloadUrl)) {
    throw new Error("release asset redirected outside GitHub");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) !== asset.size) {
    throw new Error("release asset content length differs from GitHub metadata");
  }
  if (response.body === null) throw new Error("release asset has no body");
  const file = await open(destination, "wx", 0o600);
  const digest = createHash("sha256");
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > asset.size || received > MAX_RELEASE_ASSET_BYTES) {
        await reader.cancel();
        throw new Error("release asset exceeded its declared size");
      }
      digest.update(next.value);
      await file.write(next.value);
    }
    await file.sync();
  } finally {
    await file.close();
  }
  if (received !== asset.size) throw new Error("release asset download was truncated");
  if (`sha256:${digest.digest("hex")}` !== asset.digest) {
    throw new Error("release asset checksum does not match GitHub metadata");
  }
}
