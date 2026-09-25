import { chmod, lstat, opendir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Path-free refusal raised before changing a directory owned by another POSIX user. */
export class UnsafeOwnedTreeError extends Error {
  constructor(message = "cleanup tree is not owned by the current user") {
    super(message);
    this.name = "UnsafeOwnedTreeError";
  }
}

export interface RemoveOwnedTreeOptions {
  /** Test seam for the effective POSIX user id. */
  currentUid?: number;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Remove one private, current-user-owned tree whose directories may be intentionally read-only.
 *
 * Symbolic links are never traversed. On POSIX, only real directories owned by the effective user
 * have their traversal/removal rights restored. The caller must supply private trusted ancestors;
 * this helper does not defend against a malicious same-user race.
 */
export async function removeOwnedTree(
  root: string,
  options: RemoveOwnedTreeOptions = {},
): Promise<void> {
  const currentUid = options.currentUid ?? process.getuid?.();
  const restore = async (path: string, rootEntry: boolean): Promise<void> => {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      if (rootEntry) throw new UnsafeOwnedTreeError("cleanup root is not a real directory");
      return;
    }
    if (currentUid === undefined || info.uid !== currentUid) throw new UnsafeOwnedTreeError();
    await chmod(path, 0o700);
    const entries = await opendir(path);
    for await (const entry of entries) await restore(join(path, entry.name), false);
  };

  await restore(root, true);
  await rm(root, { recursive: true, force: true });
}
