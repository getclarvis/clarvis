import type { LocalContainerReleaseSelection } from "@clarvis/kernel/bootstrap";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  candidateVersion,
  CANDIDATE_REPOSITORY,
  parseRuntimeCandidate,
} from "./runtime-candidate.ts";

const RUNTIME_RELEASE_ASSET = "runtime-release.json";
const RUNTIME_RELEASE_REPOSITORY = "getclarvis/clarvis-releases";
const MAX_MANIFEST_BYTES = 64 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const REVISION = /^[0-9a-f]{40}$/u;

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

interface ReleaseTarget {
  base: { image: string; digest: `sha256:${string}`; abi: "clarvis-linux-glibc-v1" };
  artifact: { asset: string; sha256: string; size: number };
  kernel_wire_version: 10;
  broker_version: 1;
  channel_version: 1;
}

function releaseTarget(value: unknown, target: "linux-x64" | "linux-arm64"): ReleaseTarget {
  const root = record(value);
  const base = record(root?.base);
  const artifact = record(root?.artifact);
  if (
    root === undefined ||
    base === undefined ||
    artifact === undefined ||
    Object.keys(root).sort().join(",") !==
      "artifact,base,broker_version,channel_version,kernel_wire_version" ||
    Object.keys(base).sort().join(",") !== "abi,digest,image" ||
    Object.keys(artifact).sort().join(",") !== "asset,sha256,size" ||
    typeof base.image !== "string" ||
    !/^[a-z0-9][a-z0-9._:/-]*$/u.test(base.image) ||
    typeof base.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(base.digest) ||
    base.abi !== "clarvis-linux-glibc-v1" ||
    artifact.asset !== `clarvis-kernel-${target}.tar.gz` ||
    typeof artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
    typeof artifact.size !== "number" ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size <= 0 ||
    root.kernel_wire_version !== 10 ||
    root.broker_version !== 1 ||
    root.channel_version !== 1
  )
    throw integrityError("runtime release target identity is invalid");
  return {
    base: {
      image: base.image,
      digest: base.digest as `sha256:${string}`,
      abi: "clarvis-linux-glibc-v1",
    },
    artifact: { asset: artifact.asset, sha256: artifact.sha256, size: artifact.size },
    kernel_wire_version: 10,
    broker_version: 1,
    channel_version: 1,
  };
}

async function releaseJson(
  url: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  let current = url;
  for (let redirects = 0; ; redirects++) {
    const checked = new URL(current);
    if (
      !trustedDownloadUrl(current) ||
      checked.port !== "" ||
      checked.username !== "" ||
      checked.password !== ""
    )
      throw integrityError("runtime release destination is untrusted");
    const response = await fetcher(current, {
      redirect: "manual",
      signal:
        signal === undefined
          ? AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
          : AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
      headers: { accept: "application/json", "user-agent": "clarvis-container" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (redirects >= 5 || location === null)
        throw integrityError("runtime release redirect is invalid");
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) throw integrityError("runtime release manifest download failed");
    return JSON.parse(await boundedText(response)) as unknown;
  }
}

/** Resolve one admitted base/artifact pair without downloading or mounting product bytes. */
export async function resolveClarvisContainerRelease(options: {
  readonly currentVersion: string;
  readonly target: "linux-x64" | "linux-arm64";
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<LocalContainerReleaseSelection> {
  const environment = options.environment ?? process.env;
  const localArtifact = environment.CLARVIS_RUNTIME_ARTIFACT;
  const localBase = environment.CLARVIS_RUNTIME_BASE;
  if (environment.CLARVIS_CODE_SOURCE === "1") {
    if (localArtifact === undefined || localBase === undefined)
      throw integrityError(
        "source Container requires explicit CLARVIS_RUNTIME_BASE and CLARVIS_RUNTIME_ARTIFACT",
      );
    const path = resolve(localArtifact);
    const bytes = await Bun.file(path).bytes();
    const size = (await stat(path)).size;
    const child = Bun.spawn(["tar", "-xOzf", path, "manifest.json"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const manifest = JSON.parse(await new Response(child.stdout).text()) as Record<string, unknown>;
    if (
      (await child.exited) !== 0 ||
      manifest.productVersion !== options.currentVersion ||
      manifest.target !== options.target ||
      typeof manifest.sourceRevision !== "string"
    )
      throw integrityError("local Container artifact identity is invalid");
    return {
      base: { reference: localBase, pull: false },
      artifact: {
        source: { kind: "local", archivePath: path },
        selection: {
          productVersion: options.currentVersion,
          sourceRevision: manifest.sourceRevision,
          target: options.target,
          baseAbi: "clarvis-linux-glibc-v1",
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          size,
        },
      },
    };
  }
  if (!VERSION.test(options.currentVersion))
    throw integrityError("Clarvis version cannot select a Container release");
  const candidate = environment.CLARVIS_RUNTIME_CANDIDATE;
  let parsed: Record<string, unknown> | undefined;
  let repository: "getclarvis/clarvis-releases" | "getclarvis/clarvis" =
    "getclarvis/clarvis-releases";
  let tag = `v${options.currentVersion}`;
  if (candidate !== undefined) {
    if (
      candidateVersion(candidate) !== options.currentVersion ||
      !REVISION.test(environment.CLARVIS_RUNTIME_CANDIDATE_REVISION ?? "")
    )
      throw integrityError("installed candidate identity is invalid");
    const candidateManifest = parseRuntimeCandidate(
      await releaseJson(
        `https://github.com/${CANDIDATE_REPOSITORY}/releases/download/${candidate}/runtime-candidate.json`,
        options.fetcher ?? globalThis.fetch,
        options.signal,
      ),
      candidate,
    );
    if (candidateManifest.source_revision !== environment.CLARVIS_RUNTIME_CANDIDATE_REVISION)
      throw integrityError("installed candidate source revision is invalid");
    parsed = record(candidateManifest.runtime);
    repository = "getclarvis/clarvis";
    tag = candidate;
  } else {
    parsed = record(
      await releaseJson(
        `https://github.com/${RUNTIME_RELEASE_REPOSITORY}/releases/download/v${options.currentVersion}/${RUNTIME_RELEASE_ASSET}`,
        options.fetcher ?? globalThis.fetch,
        options.signal,
      ),
    );
  }
  const targets = record(parsed?.targets);
  if (
    parsed === undefined ||
    targets === undefined ||
    Object.keys(parsed).sort().join(",") !== "schema_version,source_revision,targets,version" ||
    parsed.schema_version !== 2 ||
    parsed.version !== options.currentVersion ||
    typeof parsed.source_revision !== "string" ||
    !REVISION.test(parsed.source_revision) ||
    Object.keys(targets).sort().join(",") !== "linux-arm64,linux-x64"
  )
    throw integrityError("runtime release manifest identity is invalid");
  const selected = releaseTarget(targets[options.target], options.target);
  return {
    base: { reference: `${selected.base.image}@${selected.base.digest}`, pull: true },
    artifact: {
      source: {
        kind: "release",
        repository,
        tag,
        assetName: selected.artifact.asset,
      },
      selection: {
        productVersion: options.currentVersion,
        sourceRevision: parsed.source_revision,
        target: options.target,
        baseAbi: selected.base.abi,
        digest: `sha256:${selected.artifact.sha256}`,
        size: selected.artifact.size,
      },
    },
  };
}
