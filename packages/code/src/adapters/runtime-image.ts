import {
  candidateVersion,
  parseRuntimeCandidate,
  CANDIDATE_REPOSITORY,
} from "./runtime-candidate.ts";
import type { RuntimeImageSelection } from "@clarvis/kernel/local";
import { RUNTIME_PROTOCOL_REVISION } from "@clarvis/kernel";

const RUNTIME_RELEASE_ASSET = "runtime-release.json";
const RUNTIME_RELEASE_REPOSITORY = "getclarvis/clarvis-releases";
const RUNTIME_SOURCE_REPOSITORY = "getclarvis/clarvis";
const RUNTIME_IMAGE_REPOSITORY = "ghcr.io/getclarvis/clarvis-runtime";
const DEVELOPMENT_IMAGE = "clarvis-runtime:development";
const MAX_MANIFEST_BYTES = 64 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const PINNED_IMAGE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u;

function integrityError(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: "runtime_image_integrity",
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function trustedDownloadUrl(value: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    (url.hostname === "github.com" ||
      url.hostname === "objects.githubusercontent.com" ||
      url.hostname === "release-assets.githubusercontent.com")
  );
}

async function boundedText(response: Response): Promise<string> {
  if (response.body === null) throw new Error("runtime release response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_MANIFEST_BYTES) {
      await reader.cancel();
      throw integrityError("runtime release manifest exceeds its size limit");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function runtimeImageFromManifest(source: string, version: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (cause) {
    throw integrityError("runtime release manifest is not valid JSON", cause);
  }
  const manifest = record(parsed);
  const expected = [
    "artifact_image",
    "base_image",
    "build_image",
    "platforms",
    "protocol_revision",
    "repository",
    "schema",
    "source_revision",
    "runtime_image",
    "version",
  ].sort();
  if (
    manifest === undefined ||
    Object.keys(manifest)
      .sort()
      .some((key, index) => key !== expected[index]) ||
    Object.keys(manifest).length !== expected.length ||
    manifest.schema !== 1 ||
    manifest.repository !== RUNTIME_SOURCE_REPOSITORY ||
    manifest.version !== version ||
    manifest.protocol_revision !== RUNTIME_PROTOCOL_REVISION ||
    typeof manifest.source_revision !== "string" ||
    !REVISION.test(manifest.source_revision) ||
    !Array.isArray(manifest.platforms) ||
    manifest.platforms.length !== 2 ||
    manifest.platforms[0] !== "linux/amd64" ||
    manifest.platforms[1] !== "linux/arm64" ||
    typeof manifest.runtime_image !== "string" ||
    !manifest.runtime_image.startsWith(`${RUNTIME_IMAGE_REPOSITORY}@`) ||
    !PINNED_IMAGE.test(manifest.runtime_image)
  ) {
    throw integrityError("runtime release manifest identity is invalid");
  }
  return manifest.runtime_image;
}

/**
 * Resolve a simple Docker selection to either the current source image or
 * this exact product release's immutable OCI reference.
 *
 * @remarks The call is intentionally made by the lazy runtime factory, never
 * during TUI boot. Explicit candidate installations fetch their same-tag candidate manifest
 * and verify source revision and protocol before pulling. Local source development never pulls: `clarvis-develop` consumes the
 * locally built `clarvis-runtime:development` tag. Installed releases fetch
 * only their same-version bounded sidecar and pull the digest-pinned image it
 * names.
 */
export async function resolveClarvisRuntimeImage(options: {
  readonly signal?: AbortSignal;
  readonly currentVersion: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetcher?: typeof fetch;
}): Promise<RuntimeImageSelection> {
  const environment = options.environment ?? process.env;
  const candidate = environment.CLARVIS_RUNTIME_CANDIDATE;
  if (candidate === undefined && environment.CLARVIS_CODE_SOURCE === "1") {
    return { reference: DEVELOPMENT_IMAGE, pull: false };
  }
  if (!VERSION.test(options.currentVersion)) {
    throw integrityError("Clarvis product version cannot select a runtime release");
  }
  if (candidate !== undefined) {
    try {
      if (
        candidateVersion(candidate) !== options.currentVersion ||
        !REVISION.test(environment.CLARVIS_RUNTIME_CANDIDATE_REVISION ?? "")
      ) {
        throw new Error("candidate source identity differs from the installed version");
      }
    } catch (cause) {
      throw integrityError("invalid installed candidate identity", cause);
    }
  }
  const url =
    candidate !== undefined
      ? `https://github.com/${CANDIDATE_REPOSITORY}/releases/download/${candidate}/runtime-candidate.json`
      : `https://github.com/${RUNTIME_RELEASE_REPOSITORY}/releases/download/` +
        `v${options.currentVersion}/${RUNTIME_RELEASE_ASSET}`;
  const response = await (options.fetcher ?? globalThis.fetch)(url, {
    redirect: "follow",
    signal:
      options.signal === undefined
        ? AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
        : AbortSignal.any([options.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
    headers: {
      accept: "application/json",
      "user-agent": `clarvis/${options.currentVersion}`,
    },
  });
  if (!response.ok) {
    throw new Error(`runtime release manifest failed with HTTP ${String(response.status)}`);
  }
  if (!trustedDownloadUrl(response.url || url)) {
    throw integrityError("runtime release manifest redirected outside GitHub");
  }
  const source = await boundedText(response);
  if (candidate !== undefined) {
    try {
      const manifest = parseRuntimeCandidate(JSON.parse(source), candidate);
      if (
        manifest.protocol_revision !== RUNTIME_PROTOCOL_REVISION ||
        manifest.source_revision !== environment.CLARVIS_RUNTIME_CANDIDATE_REVISION
      ) {
        throw new Error("candidate runtime does not match installed source or protocol");
      }
      return { reference: manifest.runtime_image, pull: true };
    } catch (cause) {
      throw integrityError("candidate runtime identity is invalid", cause);
    }
  }
  return {
    reference: runtimeImageFromManifest(source, options.currentVersion),
    pull: true,
  };
}
