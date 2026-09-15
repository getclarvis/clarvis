import { kernelError } from "../core/errors.ts";

/** Immutable production ceilings; callers cannot increase admission budgets. */
export const RUNTIME_ARTIFACT_LIMITS = Object.freeze({
  manifestBytes: 1024 * 1024,
  files: 4096,
  compressedBytes: 512 * 1024 * 1024,
  extractedBytes: 1024 * 1024 * 1024,
  tarBytes: 1024 * 1024 * 1024 + 16 * 1024 * 1024,
  entries: 8193,
  redirects: 5,
});

/** Identity selected by trusted host release/build composition, never by a guest. */
export interface RuntimeArtifactIdentity {
  readonly productVersion: string;
  readonly sourceRevision: string;
  readonly target: "linux-x64" | "linux-arm64";
  readonly baseAbi: "clarvis-linux-glibc-v1";
}

/** Exact compressed bytes admitted by the host release resolver or local builder. */
export interface RuntimeArtifactSelection extends RuntimeArtifactIdentity {
  readonly digest: `sha256:${string}`;
  readonly size: number;
}

/** One regular file, excluding the manifest itself. */
export interface RuntimeArtifactFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly executable: boolean;
}

/** Closed compiled-Kernel manifest; legacy OCI/portable manifests are not accepted. */
export interface RuntimeArtifactManifest extends RuntimeArtifactIdentity {
  readonly schemaVersion: 1;
  readonly dirty: boolean;
  readonly kernelWireVersion: 11;
  readonly brokerVersion: 1;
  readonly channelVersion: 1;
  readonly entrypoint: "bin/clarvis-kernel";
  readonly files: readonly RuntimeArtifactFile[];
}

/** Stable local integrity failure; messages never include source URLs or archive text. */
export function artifactFailure(message: string): never {
  throw kernelError("invalid_request", `runtime artifact: ${message}`);
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    artifactFailure("invalid object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join(",") !== keys.sort().join(","))
    artifactFailure("unknown or missing fields");
  return result;
}

/** Exact SemVer syntax, including numeric prerelease leading-zero rejection. */
function validArtifactVersion(value: string): boolean {
  const match =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  return match !== null && !(match[4]?.split(".").some((part) => /^0[0-9]+$/.test(part)) ?? false);
}

/** Portable canonical ASCII paths, bounded to 256 characters and 16 components. */
export function validArtifactPath(path: string): boolean {
  const parts = path.split("/");
  return (
    path.length <= 256 &&
    parts.length <= 16 &&
    parts.every(
      (part) =>
        /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) &&
        !part.endsWith(".") &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  );
}

/** Root payload namespace, independent of archive member type. */
export function payloadPath(path: string): boolean {
  return (
    validArtifactPath(path) &&
    (path === "bin/clarvis-kernel" ||
      path === "LICENSE" ||
      path.startsWith("assets/") ||
      path.startsWith("licenses/"))
  );
}

/** Revalidate even typed host inputs before any filesystem or network work. */
export function assertArtifactSelection(value: RuntimeArtifactSelection): void {
  if (
    !validArtifactVersion(value.productVersion) ||
    !/^[0-9a-f]{40}$/.test(value.sourceRevision) ||
    !["linux-x64", "linux-arm64"].includes(value.target) ||
    value.baseAbi !== "clarvis-linux-glibc-v1" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.digest) ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    value.size > RUNTIME_ARTIFACT_LIMITS.compressedBytes
  )
    artifactFailure("invalid selected identity or compressed size");
}

/** Parse bounded UTF-8 JSON with exact keys, identity, ordering and aggregate size. */
export function parseRuntimeArtifactManifest(
  bytes: Uint8Array,
  expected?: RuntimeArtifactIdentity,
): RuntimeArtifactManifest {
  if (bytes.byteLength > RUNTIME_ARTIFACT_LIMITS.manifestBytes)
    artifactFailure("manifest size limit");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    artifactFailure("invalid manifest JSON");
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion !== 1
  ) {
    throw kernelError(
      "unsupported",
      "Runtime artifact schema is unsupported; select an updated artifact",
    );
  }
  const m = object(value, [
    "schemaVersion",
    "productVersion",
    "sourceRevision",
    "dirty",
    "target",
    "baseAbi",
    "kernelWireVersion",
    "brokerVersion",
    "channelVersion",
    "entrypoint",
    "files",
  ]);
  if (
    m.schemaVersion !== 1 ||
    typeof m.productVersion !== "string" ||
    !validArtifactVersion(m.productVersion) ||
    typeof m.sourceRevision !== "string" ||
    !/^[0-9a-f]{40}$/.test(m.sourceRevision) ||
    typeof m.dirty !== "boolean" ||
    !["linux-x64", "linux-arm64"].includes(String(m.target)) ||
    m.baseAbi !== "clarvis-linux-glibc-v1" ||
    m.kernelWireVersion !== 11 ||
    m.brokerVersion !== 1 ||
    m.channelVersion !== 1 ||
    m.entrypoint !== "bin/clarvis-kernel" ||
    (expected !== undefined &&
      (m.productVersion !== expected.productVersion ||
        m.sourceRevision !== expected.sourceRevision ||
        m.target !== expected.target ||
        m.baseAbi !== expected.baseAbi)) ||
    !Array.isArray(m.files) ||
    m.files.length < 2 ||
    m.files.length > RUNTIME_ARTIFACT_LIMITS.files
  )
    artifactFailure("manifest identity or shape mismatch");
  let previous = "";
  let total = 0;
  const files = m.files.map((value: unknown): RuntimeArtifactFile => {
    const f = object(value, ["path", "size", "sha256", "executable"]);
    if (
      typeof f.path !== "string" ||
      !payloadPath(f.path) ||
      f.path <= previous ||
      typeof f.size !== "number" ||
      !Number.isSafeInteger(f.size) ||
      f.size <= 0 ||
      typeof f.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(f.sha256) ||
      typeof f.executable !== "boolean"
    )
      artifactFailure("invalid or unsorted file declaration");
    previous = f.path;
    total += f.size;
    if (total > RUNTIME_ARTIFACT_LIMITS.extractedBytes) artifactFailure("extracted size limit");
    return { path: f.path, size: f.size, sha256: f.sha256, executable: f.executable };
  });
  if (
    !files.some((f) => f.path === "LICENSE") ||
    !files.some((f) => f.path === "bin/clarvis-kernel" && f.executable)
  )
    artifactFailure("required payload missing");
  const paths = new Set(files.map((f) => f.path));
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++)
      if (paths.has(parts.slice(0, i).join("/"))) artifactFailure("file/directory collision");
  }
  return {
    schemaVersion: 1,
    productVersion: m.productVersion,
    sourceRevision: m.sourceRevision,
    dirty: m.dirty,
    target: m.target as RuntimeArtifactIdentity["target"],
    baseAbi: "clarvis-linux-glibc-v1",
    kernelWireVersion: 11,
    brokerVersion: 1,
    channelVersion: 1,
    entrypoint: "bin/clarvis-kernel",
    files,
  };
}
