import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DIR_MODE, FILE_MODE, fsyncDir } from "@clarvis/paths";
import { kernelError } from "../core/errors.ts";
import type { ProjectionStorage } from "./projection.ts";
import { recoverProjectionIO, type ProjectionRecoveryOptions } from "./projection-io.ts";

/** Minimal positional file operations; injected handles retain the same exclusive ownership contract. */
export interface ProjectionFile {
  write(
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }>;
  read(
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** Filesystem seam for deterministic faults before or after an individual syscall. */
export interface ProjectionStorageOptions extends ProjectionRecoveryOptions {
  openFile?: (path: string, flags: string, mode?: number) => Promise<ProjectionFile>;
  syncDirectory?: (path: string) => Promise<void>;
}

/** Open a private append-only byte stream with one active segment and bounded read buffers. */
export async function openProjectionStorage(
  file: string,
  segmentBytes: number,
  options: ProjectionStorageOptions = {},
): Promise<ProjectionStorage> {
  if (!Number.isSafeInteger(segmentBytes) || segmentBytes <= 0)
    throw new RangeError("segmentBytes must be a positive safe integer");
  await mkdir(dirname(file), { recursive: true, mode: DIR_MODE });
  const path = (index: number): string => (index === 0 ? file : `${file}.segment.${index}`);
  const openFile = options.openFile ?? open;
  const syncDirectory = () =>
    recoverProjectionIO(
      "sync_directory",
      size,
      () => (options.syncDirectory ?? fsyncDir)(dirname(file)),
      options,
    );
  let handle = await openFile(file, "wx+", FILE_MODE);
  let index = 0;
  let size = 0;
  try {
    await syncDirectory();
  } catch (error) {
    await handle.close();
    throw error;
  }
  return {
    async write(bytes, offset) {
      if (offset !== size) throw kernelError("conflict", "projection append offset changed");
      let written = 0;
      while (written < bytes.length) {
        const nextIndex = Math.floor((offset + written) / segmentBytes);
        if (nextIndex !== index) {
          await recoverProjectionIO("sync_file", offset + written, () => handle.sync(), options);
          const next = await openFile(path(nextIndex), "wx+", FILE_MODE);
          try {
            await syncDirectory();
          } catch (error) {
            await next.close();
            throw error;
          }
          try {
            await handle.close();
          } catch (error) {
            await next.close();
            throw error;
          }
          handle = next;
          index = nextIndex;
        }
        const position = (offset + written) % segmentBytes;
        const count = Math.min(bytes.length - written, segmentBytes - position);
        const result = await recoverProjectionIO(
          "write",
          offset + written,
          () => handle.write(bytes, written, count, position),
          options,
        );
        if (result.bytesWritten === 0)
          throw kernelError("unavailable", "projection write made no progress");
        written += result.bytesWritten;
      }
      size += bytes.length;
    },
    async read(offset, length) {
      const bytes = Buffer.alloc(length);
      let received = 0;
      while (received < length) {
        const readIndex = Math.floor((offset + received) / segmentBytes);
        let reader: ProjectionFile | undefined;
        try {
          reader = await openFile(path(readIndex), "r");
          const position = (offset + received) % segmentBytes;
          const count = Math.min(length - received, segmentBytes - position);
          const result = await reader.read(bytes, received, count, position);
          if (result.bytesRead === 0)
            throw kernelError("unavailable", "projection segment ended inside a snapshot");
          received += result.bytesRead;
        } finally {
          await reader?.close();
        }
      }
      return bytes;
    },
    sync: () => recoverProjectionIO("sync_file", size, () => handle.sync(), options),
    close: () => handle.close(),
  };
}

/** Reclaim only one acknowledged projection's exact segment namespace. */
export async function removeProjectionStorage(file: string): Promise<void> {
  const prefix = `${basename(file)}.segment.`;
  const entries = await readdir(dirname(file)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const name of entries) {
    if (
      name !== basename(file) &&
      !(name.startsWith(prefix) && /^[1-9]\d*$/.test(name.slice(prefix.length)))
    )
      continue;
    await unlink(join(dirname(file), name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
