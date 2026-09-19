import { createHash } from "node:crypto";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  inspectArtifactArchive,
  openArtifactFile,
  writeArtifactBytes,
} from "./runtime-artifact-archive.ts";
import { removeOwnedTree, UnsafeOwnedTreeError } from "../storage/owned-tree.ts";
import {
  artifactFailure,
  assertArtifactSelection,
  parseRuntimeArtifactManifest,
  RUNTIME_ARTIFACT_LIMITS as limits,
  type RuntimeArtifactManifest,
  type RuntimeArtifactSelection,
} from "./runtime-artifact-manifest.ts";

export {
  RUNTIME_ARTIFACT_LIMITS,
  parseRuntimeArtifactManifest,
} from "./runtime-artifact-manifest.ts";
export type {
  RuntimeArtifactFile,
  RuntimeArtifactIdentity,
  RuntimeArtifactManifest,
  RuntimeArtifactSelection,
} from "./runtime-artifact-manifest.ts";
export { prepareRuntimeArtifactVolume } from "./runtime-artifact-volume.ts";

/** Host-authored acquisition inputs. No arbitrary URL, workspace setting or guest DTO is accepted.
 * Release metadata must already be admitted by the host resolver. Repository is a closed product
 * origin choice; assetName and tag are exact host-selected release coordinates, not URL fragments.
 */
export type RuntimeArtifactSource =
  | { readonly kind: "local"; readonly archivePath: string }
  | {
      readonly kind: "release";
      readonly repository: "getclarvis/clarvis-releases" | "getclarvis/clarvis";
      readonly tag: string;
      readonly assetName: string;
    };

/** Test-owned transport seam; production uses host fetch with redirects disabled. */
export type RuntimeArtifactFetch = (url: string, init: RequestInit) => Promise<Response>;

/** A verified host-local cache tree. Only its admitted archive is transferred to the engine. */
export interface CachedRuntimeArtifact {
  readonly root: string;
  readonly archivePath: string;
  readonly entrypoint: string;
  readonly manifest: RuntimeArtifactManifest;
}

/** Validate an archive for a builder or host without extracting or executing its contents. */
export async function validateRuntimeArtifact(
  archivePath: string,
  selection: RuntimeArtifactSelection,
  signal?: AbortSignal,
): Promise<RuntimeArtifactManifest> {
  return inspectArtifactArchive(archivePath, selection, undefined, signal);
}

function checkedUrl(url: URL): string {
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    ![
      "github.com",
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com",
    ].includes(url.hostname)
  )
    artifactFailure("untrusted download destination");
  return url.href;
}

function releaseUrl(
  source: Extract<RuntimeArtifactSource, { kind: "release" }>,
  selection: RuntimeArtifactSelection,
): string {
  if (
    !["getclarvis/clarvis-releases", "getclarvis/clarvis"].includes(source.repository) ||
    !(
      source.tag === `v${selection.productVersion}` ||
      (source.repository === "getclarvis/clarvis" &&
        source.tag.startsWith(`v${selection.productVersion}-rc.`) &&
        /^[1-9][0-9]*$/.test(source.tag.slice(`v${selection.productVersion}-rc.`.length)))
    ) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.+-]*\.tar\.gz$/.test(source.assetName) ||
    source.assetName.length > 200
  )
    artifactFailure("invalid host release coordinates");
  return checkedUrl(
    new URL(
      `https://github.com/${source.repository}/releases/download/${encodeURIComponent(source.tag)}/${encodeURIComponent(source.assetName)}`,
    ),
  );
}

async function download(
  source: Extract<RuntimeArtifactSource, { kind: "release" }>,
  selection: RuntimeArtifactSelection,
  destination: string,
  fetcher: RuntimeArtifactFetch,
  signal?: AbortSignal,
): Promise<void> {
  let url = releaseUrl(source, selection);
  const timeout = AbortSignal.timeout(180_000);
  const effectiveSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  for (let redirects = 0; ; redirects++) {
    effectiveSignal.throwIfAborted();
    checkedUrl(new URL(url));
    const response = await fetcher(url, {
      redirect: "manual",
      credentials: "omit",
      signal: effectiveSignal,
      headers: { accept: "application/octet-stream" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (redirects >= limits.redirects || location === null)
        artifactFailure("redirect limit or missing location");
      url = checkedUrl(new URL(location, url));
      continue;
    }
    if (!response.ok || response.redirected || (response.url !== "" && response.url !== url)) {
      await response.body?.cancel();
      artifactFailure("download response refused");
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) !== selection.size)) {
      await response.body?.cancel();
      artifactFailure("download content length mismatch");
    }
    if (response.body === null) artifactFailure("missing download body");
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    let output: FileHandle | undefined;
    let size = 0;
    const digest = createHash("sha256");
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    effectiveSignal.addEventListener("abort", cancel, { once: true });
    try {
      effectiveSignal.throwIfAborted();
      output = await open(destination, "wx", 0o600);
      while (true) {
        effectiveSignal.throwIfAborted();
        const next = await reader.read();
        effectiveSignal.throwIfAborted();
        if (next.done) break;
        size += next.value.length;
        if (size > selection.size || size > limits.compressedBytes)
          artifactFailure("download size limit");
        digest.update(next.value);
        await writeArtifactBytes(output, next.value, effectiveSignal);
      }
      if (size !== selection.size || `sha256:${digest.digest("hex")}` !== selection.digest)
        artifactFailure("download size or digest mismatch");
      await output.sync();
    } finally {
      effectiveSignal.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      await output?.close();
    }
    return;
  }
}

async function copyLocal(
  path: string,
  destination: string,
  selection: RuntimeArtifactSelection,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const input = await openArtifactFile(path, limits.compressedBytes);
  let output: FileHandle | undefined;
  try {
    signal.throwIfAborted();
    output = await open(destination, "wx", 0o600);
    const buffer = new Uint8Array(64 * 1024);
    let size = 0;
    while (true) {
      signal.throwIfAborted();
      const { bytesRead } = await input.read(buffer);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > selection.size) artifactFailure("local archive size limit");
      await writeArtifactBytes(output, buffer.subarray(0, bytesRead), signal);
    }
    if (size !== selection.size) artifactFailure("local archive size mismatch");
    await output.sync();
  } finally {
    await input.close();
    await output?.close();
  }
}

async function directory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    artifactFailure("cache directory is not a real directory");
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyTree(
  root: string,
  manifest: RuntimeArtifactManifest,
  signal: AbortSignal,
): Promise<void> {
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const directories = new Set<string>();
  for (const file of manifest.files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  let count = 0;
  const visit = async (path: string, prefix: string): Promise<void> => {
    signal.throwIfAborted();
    await directory(path);
    const entries = await opendir(path);
    for await (const entry of entries) {
      signal.throwIfAborted();
      const relative = `${prefix}${entry.name}`;
      const absolute = join(path, entry.name);
      if (entry.isDirectory() && directories.has(relative)) {
        await visit(absolute, `${relative}/`);
        continue;
      }
      const declaration = expected.get(relative);
      if (declaration === undefined && relative !== "manifest.json")
        artifactFailure("undeclared cache entry");
      const maximum = declaration?.size ?? limits.manifestBytes;
      const file = await openArtifactFile(absolute, maximum);
      try {
        const info = await file.stat();
        if (
          process.platform !== "win32" &&
          ((info.mode & 0o7222) !== 0 ||
            (info.mode & 0o111) !== (declaration?.executable === true ? 0o111 : 0))
        )
          artifactFailure("unsafe cached permissions");
        const digest = createHash("sha256");
        const chunks: Uint8Array[] = [];
        const buffer = new Uint8Array(64 * 1024);
        let size = 0;
        while (true) {
          signal.throwIfAborted();
          const { bytesRead } = await file.read(buffer);
          if (bytesRead === 0) break;
          size += bytesRead;
          if (size > maximum) artifactFailure("cached file size limit");
          digest.update(buffer.subarray(0, bytesRead));
          if (declaration === undefined) chunks.push(buffer.slice(0, bytesRead));
        }
        if (declaration !== undefined) {
          if (size !== declaration.size || digest.digest("hex") !== declaration.sha256)
            artifactFailure("cached file size or digest mismatch");
        } else if (
          JSON.stringify(parseRuntimeArtifactManifest(Buffer.concat(chunks), manifest)) !==
          JSON.stringify(manifest)
        )
          artifactFailure("cached manifest mismatch");
      } finally {
        await file.close();
      }
      count++;
    }
  };
  await visit(root, "");
  if (count !== manifest.files.length + 1) artifactFailure("incomplete cached payload");
}

async function cachedResult(
  path: string,
  selection: RuntimeArtifactSelection,
  signal: AbortSignal,
): Promise<CachedRuntimeArtifact> {
  signal.throwIfAborted();
  await directory(path);
  const contents = await opendir(path);
  const names: string[] = [];
  for await (const entry of contents) {
    if (names.length >= 2) artifactFailure("unexpected cache content");
    names.push(entry.name);
  }
  if (names.sort().join(",") !== "archive.tar.gz,payload") artifactFailure("incomplete cache");
  const archivePath = join(path, "archive.tar.gz");
  const manifest = await validateRuntimeArtifact(archivePath, selection, signal);
  const root = join(path, "payload");
  await verifyTree(root, manifest, signal);
  signal.throwIfAborted();
  return { root, archivePath, entrypoint: join(root, "bin", "clarvis-kernel"), manifest };
}

/** Internal cleanup seam. The caller must own this exact unpublished mkdtemp stage, never an
 * admitted digest directory. Restore directory traversal/removal rights only on owned directories;
 * lstat prevents traversal or chmod through symlinks. Trusted ancestors exclude same-user races.
 * Cleanup deliberately ignores cancellation so no partial stage is abandoned on abort.
 */
export async function removeArtifactStage(stage: string): Promise<void> {
  try {
    await removeOwnedTree(stage);
  } catch (error) {
    if (error instanceof UnsafeOwnedTreeError) artifactFailure("stage directory owner changed");
    throw error;
  }
}

/** Acquire immutable bytes into a digest-keyed, host-owned local cache.
 *
 * The caller owns an absolute cache root outside guest/workspace mounts, on a local filesystem
 * whose ancestors are not attacker-writable. A same-root exclusive directory lock serializes
 * cooperating host processes; a stale lock refuses rather than guessing recovery. Existing
 * corrupt/incomplete entries are never repaired or overwritten. Every reuse verifies archive and
 * payload. Private staging is renamed only after full admission; no downloaded byte is executed.
 * One ten-minute ceiling and the caller signal cover copy, download, decompression, verification
 * and pre-publication sync. Cancellation is cooperative between bounded I/O operations; cleanup
 * completes before rejection. Rename is the commit point: an admitted entry is never rolled back.
 * This is not a defense against a malicious same-user process changing trusted cache ancestors.
 */
export async function cacheRuntimeArtifact(options: {
  readonly cacheRoot: string;
  readonly selection: RuntimeArtifactSelection;
  readonly source: RuntimeArtifactSource;
  readonly fetcher?: RuntimeArtifactFetch;
  readonly signal?: AbortSignal;
}): Promise<CachedRuntimeArtifact> {
  options.signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(600_000);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const selection = { ...options.selection };
  const source = { ...options.source };
  assertArtifactSelection(selection);
  if (!isAbsolute(options.cacheRoot)) artifactFailure("cache root must be host-local and absolute");
  if (source.kind === "release") releaseUrl(source, selection);
  else if (source.kind !== "local" || !isAbsolute(source.archivePath))
    artifactFailure("invalid local source");
  signal.throwIfAborted();
  await mkdir(options.cacheRoot, { recursive: true, mode: 0o700 });
  await directory(options.cacheRoot);
  const rootInfo = await lstat(options.cacheRoot);
  if (
    process.platform !== "win32" &&
    ((rootInfo.mode & 0o077) !== 0 || rootInfo.uid !== process.getuid?.())
  ) {
    artifactFailure("cache root must be private to the host owner");
  }
  const key = selection.digest.slice(7);
  const destination = join(options.cacheRoot, key);
  const lock = join(options.cacheRoot, `${key}.lock`);
  signal.throwIfAborted();
  await mkdir(lock, { mode: 0o700 });
  let stage: string | undefined;
  try {
    signal.throwIfAborted();
    const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (existing !== undefined) {
      const cached = await cachedResult(destination, selection, signal);
      if (source.kind === "release" && cached.manifest.dirty)
        artifactFailure("published artifacts must have dirty:false");
      return cached;
    }
    signal.throwIfAborted();
    stage = await mkdtemp(join(options.cacheRoot, ".runtime-artifact-"));
    const archive = join(stage, "archive.tar.gz");
    if (source.kind === "local") await copyLocal(source.archivePath, archive, selection, signal);
    else await download(source, selection, archive, options.fetcher ?? globalThis.fetch, signal);
    signal.throwIfAborted();
    const payload = join(stage, "payload");
    await mkdir(payload, { mode: 0o700 });
    await inspectArtifactArchive(archive, selection, payload, signal);
    signal.throwIfAborted();
    await chmod(archive, 0o400);
    const result = await cachedResult(stage, selection, signal);
    if (source.kind === "release" && result.manifest.dirty)
      artifactFailure("published artifacts must have dirty:false");
    const syncTree = async (path: string): Promise<void> => {
      signal.throwIfAborted();
      const entries = await opendir(path);
      for await (const entry of entries)
        if (entry.isDirectory()) await syncTree(join(path, entry.name));
      await syncDirectory(path);
    };
    await syncTree(stage);
    signal.throwIfAborted();
    await rename(stage, destination);
    stage = undefined;
    await syncDirectory(options.cacheRoot);
    return {
      ...result,
      root: join(destination, "payload"),
      archivePath: join(destination, "archive.tar.gz"),
      entrypoint: join(destination, "payload", "bin", "clarvis-kernel"),
    };
  } finally {
    try {
      if (stage !== undefined) await removeArtifactStage(stage);
    } finally {
      await rm(lock, { recursive: true });
    }
  }
}
