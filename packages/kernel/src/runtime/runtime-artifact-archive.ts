import { setImmediate } from "node:timers/promises";
import { createHash } from "node:crypto";
import {
  DecompressionStream,
  ReadableStream,
  type ReadableStreamDefaultReader,
} from "node:stream/web";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  artifactFailure,
  assertArtifactSelection,
  payloadPath,
  validArtifactPath,
  parseRuntimeArtifactManifest,
  RUNTIME_ARTIFACT_LIMITS as limits,
  type RuntimeArtifactManifest,
  type RuntimeArtifactSelection,
} from "./runtime-artifact-manifest.ts";

/** Descriptor-backed regular-file admission; cache and source paths must not be links. */
export async function openArtifactFile(path: string, maximum: number): Promise<FileHandle> {
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.size > maximum)
    artifactFailure("non-regular, linked or oversized file");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > maximum ||
      info.dev !== before.dev ||
      info.ino !== before.ino
    )
      artifactFailure("file identity changed");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** Handle short writes without silently omitting bytes. */
export async function writeArtifactBytes(
  file: FileHandle,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    signal?.throwIfAborted();
    const { bytesWritten } = await file.write(bytes.subarray(offset));
    if (bytesWritten === 0) artifactFailure("short file write");
    offset += bytesWritten;
  }
}

function compressedStream(
  file: FileHandle,
  selection: RuntimeArtifactSelection,
  signal?: AbortSignal,
): ReadableStream<NodeJS.BufferSource> {
  let received = 0;
  const digest = createHash("sha256");
  return new ReadableStream({
    async pull(controller) {
      signal?.throwIfAborted();
      const buffer = new Uint8Array(64 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, received);
      if (bytesRead === 0) {
        if (received !== selection.size || `sha256:${digest.digest("hex")}` !== selection.digest)
          artifactFailure("archive size or digest mismatch");
        controller.close();
        return;
      }
      received += bytesRead;
      if (received > selection.size || received > limits.compressedBytes)
        artifactFailure("compressed size limit");
      const bytes = buffer.subarray(0, bytesRead);
      digest.update(bytes);
      controller.enqueue(bytes);
    },
  });
}

class TarReader {
  private chunk: Uint8Array = new Uint8Array(0);
  private offset = 0;
  private total = 0;
  constructor(
    private readonly reader: ReadableStreamDefaultReader<NodeJS.NonSharedUint8Array>,
    private readonly signal?: AbortSignal,
  ) {}
  async take(maximum: number): Promise<Uint8Array> {
    await setImmediate(undefined, { signal: this.signal });
    this.signal?.throwIfAborted();
    if (this.offset === this.chunk.length) {
      const next = await this.reader.read();
      if (next.done) return new Uint8Array(0);
      this.total += next.value.byteLength;
      if (this.total > limits.tarBytes) artifactFailure("tar stream size limit");
      this.chunk = next.value;
      this.offset = 0;
    }
    const result = this.chunk.subarray(this.offset, this.offset + maximum);
    this.offset += result.length;
    return result;
  }
  async exact(size: number): Promise<Uint8Array> {
    const result = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const next = await this.take(size - offset);
      if (next.length === 0) artifactFailure("truncated tar");
      result.set(next, offset);
      offset += next.length;
    }
    return result;
  }
}

function text(header: Uint8Array, start: number, size: number): string {
  const field = header.subarray(start, start + size);
  const zero = field.indexOf(0);
  if (zero !== -1 && field.subarray(zero).some((b) => b !== 0))
    artifactFailure("invalid tar text padding");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      zero === -1 ? field : field.subarray(0, zero),
    );
  } catch {
    artifactFailure("invalid tar text");
  }
}

function octal(header: Uint8Array, start: number, size: number): number {
  const field = new TextDecoder().decode(header.subarray(start, start + size));
  if (!/^[ 0-7]*[\0 ]*$/.test(field)) artifactFailure("unsupported tar number");
  const result = parseInt(field.replace(/[\0 ]/g, "") || "0", 8);
  if (!Number.isSafeInteger(result)) artifactFailure("tar number limit");
  return result;
}

interface ObservedFile {
  size: number;
  sha256: string;
  mode: number;
}

/** Validate a bounded ustar gzip stream; extraction is only into a newly owned private stage. */
export async function inspectArtifactArchive(
  archivePath: string,
  selection: RuntimeArtifactSelection,
  destination?: string,
  signal?: AbortSignal,
): Promise<RuntimeArtifactManifest> {
  signal?.throwIfAborted();
  assertArtifactSelection(selection);
  const file = await openArtifactFile(archivePath, limits.compressedBytes);
  try {
    const digest = createHash("sha256");
    const buffer = new Uint8Array(64 * 1024);
    let size = 0;
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, size);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > selection.size) artifactFailure("compressed size limit");
      digest.update(buffer.subarray(0, bytesRead));
    }
    if (size !== selection.size || `sha256:${digest.digest("hex")}` !== selection.digest)
      artifactFailure("archive size or digest mismatch");
    signal?.throwIfAborted();
  } catch (error) {
    await file.close();
    throw error;
  }
  const reader = compressedStream(file, selection, signal)
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const tar = new TarReader(reader, signal);
  const observed = new Map<string, ObservedFile>();
  const directories = new Set<string>();
  const members = new Set<string>();
  let manifestBytes: Uint8Array | undefined;
  let extracted = 0;
  try {
    while (true) {
      const header = await tar.exact(512);
      if (header.every((byte) => byte === 0)) {
        if ((await tar.exact(512)).some((byte) => byte !== 0))
          artifactFailure("invalid tar end marker");
        while (true) {
          const tail = await tar.take(64 * 1024);
          if (tail.length === 0) break;
          if (tail.some((byte) => byte !== 0)) artifactFailure("trailing tar data");
        }
        break;
      }
      const checksum = header.reduce(
        (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
        0,
      );
      if (checksum !== octal(header, 148, 8)) artifactFailure("tar checksum mismatch");
      if (text(header, 257, 6) !== "ustar" || text(header, 263, 2) !== "00")
        artifactFailure("unsupported tar format");
      const type = header[156];
      if (type !== 0 && type !== 48 && type !== 53) artifactFailure("unsupported tar member type");
      if (
        text(header, 157, 100) !== "" ||
        octal(header, 329, 8) !== 0 ||
        octal(header, 337, 8) !== 0
      )
        artifactFailure("linked or device tar member");
      const prefix = text(header, 345, 155);
      const name = text(header, 0, 100);
      const rawPath = prefix === "" ? name : `${prefix}/${name}`;
      const path = type === 53 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
      const size = octal(header, 124, 12);
      const mode = octal(header, 100, 8);
      if ((mode & 0o6000) !== 0 || mode > 0o7777) artifactFailure("unsafe tar permissions");
      if (!validArtifactPath(path) || members.has(path) || members.size >= limits.entries)
        artifactFailure("invalid, duplicate or excessive tar members");
      members.add(path);
      if (type === 53) {
        if (
          size !== 0 ||
          !(path === "bin" || path === "assets" || path === "licenses" || payloadPath(path))
        )
          artifactFailure("invalid tar directory");
        directories.add(path);
        continue;
      }
      if (path !== "manifest.json" && !payloadPath(path))
        artifactFailure("unexpected root payload");
      if (size <= 0 || (path === "manifest.json" && size > limits.manifestBytes))
        artifactFailure("file or manifest size limit");
      extracted += size;
      if (extracted > limits.extractedBytes || observed.size >= limits.files + 1)
        artifactFailure("extracted file limit");
      let output: FileHandle | undefined;
      if (destination !== undefined) {
        signal?.throwIfAborted();
        const target = join(destination, ...path.split("/"));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        output = await open(target, "wx", 0o600);
      }
      const digest = createHash("sha256");
      const chunks: Uint8Array[] = [];
      try {
        let remaining = size;
        while (remaining > 0) {
          const bytes = await tar.take(Math.min(remaining, 64 * 1024));
          if (bytes.length === 0) artifactFailure("truncated tar file");
          remaining -= bytes.length;
          digest.update(bytes);
          if (path === "manifest.json") chunks.push(bytes.slice());
          if (output !== undefined) await writeArtifactBytes(output, bytes, signal);
        }
        if (output !== undefined) await output.sync();
      } finally {
        await output?.close();
      }
      if (path === "manifest.json") manifestBytes = Buffer.concat(chunks);
      observed.set(path, { size, sha256: digest.digest("hex"), mode });
      const padding = (512 - (size % 512)) % 512;
      if ((await tar.exact(padding)).some((byte) => byte !== 0))
        artifactFailure("invalid tar file padding");
    }
    if (manifestBytes === undefined) artifactFailure("missing manifest");
    const manifest = parseRuntimeArtifactManifest(manifestBytes, selection);
    if (observed.size !== manifest.files.length + 1) artifactFailure("undeclared or missing files");
    for (const declared of manifest.files) {
      const actual = observed.get(declared.path);
      if (
        actual === undefined ||
        actual.size !== declared.size ||
        actual.sha256 !== declared.sha256
      )
        artifactFailure("file size or digest mismatch");
    }
    for (const directory of directories) {
      if (!manifest.files.some((entry) => entry.path.startsWith(`${directory}/`)))
        artifactFailure("undeclared directory");
    }
    if (destination !== undefined) {
      const ownedDirectories = new Set([destination]);
      for (const declared of manifest.files) {
        signal?.throwIfAborted();
        const parts = declared.path.split("/");
        for (let i = 1; i < parts.length; i++)
          ownedDirectories.add(join(destination, ...parts.slice(0, i)));
        const actual = observed.get(declared.path)!;
        await chmod(
          join(destination, ...declared.path.split("/")),
          (actual.mode & 0o444) | (declared.executable ? 0o111 : 0),
        );
      }
      await chmod(join(destination, "manifest.json"), 0o444);
      for (const path of [...ownedDirectories].reverse()) {
        signal?.throwIfAborted();
        await chmod(path, 0o555);
      }
    }
    signal?.throwIfAborted();
    return manifest;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await file.close();
  }
}
