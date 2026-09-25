import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DIR_MODE, FILE_MODE, ancestorTrust } from "@clarvis/paths";
import { kernelError } from "../core/errors.ts";

/** Existing private state is verified, never chmod-repaired after credentials may have been exposed. */
export async function assertPrivateHostDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== resolve(path))
    throw kernelError("unauthorized", "local host state requires a canonical directory");
  if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== DIR_MODE)
    throw kernelError("unauthorized", "local host directory must be private and account-owned");
  if (!ancestorTrust(path).trusted)
    throw kernelError("unauthorized", "local host state has an unsafe parent directory");
}

/** Create the private directory before publishing any credential, then verify its real ownership. */
export async function preparePrivateHostDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIR_MODE });
  await assertPrivateHostDirectory(path);
}

/** Bounded descriptor reads refuse links, special files, changing files and permissive credentials. */
export async function readPrivateHostJson(path: string, maxBytes: number): Promise<unknown> {
  await assertPrivateHostDirectory(dirname(path));
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (handle === null) return null;
  try {
    const info = await handle.stat();
    const named = await lstat(path);
    if (
      !info.isFile() ||
      named.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.ino !== named.ino ||
      info.dev !== named.dev ||
      info.size > maxBytes
    )
      throw kernelError("invalid_request", "local host file is unsafe or exceeds its byte limit");
    if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== FILE_MODE)
      throw kernelError("unauthorized", "local host file must be private and account-owned");
    const data = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const read = await handle.read(data, offset, data.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
      throw kernelError("conflict", "local host file changed while being read");
    try {
      return JSON.parse(data.subarray(0, offset).toString("utf8")) as unknown;
    } catch {
      throw kernelError("invalid_request", "local host file is not valid JSON");
    }
  } finally {
    await handle.close();
  }
}
