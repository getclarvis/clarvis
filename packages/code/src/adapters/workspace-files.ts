import type { ImagePart, WorkspaceService } from "@clarvis/protocol";
import type { ImageLoader } from "../core/attachments.ts";
import { detachObserved } from "../core/tasks.ts";
import { hasKernelErrorCode } from "./kernel-errors.ts";

const FILES_TTL_MS = 30_000;
const MAX_FILES = 4000;

/**
 * Build a cached, lazily-refreshing accessor over the workspace's file list, for
 * `@`-mention completion.
 *
 * @param files - the kernel's workspace file listing service.
 * @returns a function returning the current cached path list; it refreshes in
 *   the background once the cache is older than {@link FILES_TTL_MS} and always
 *   returns the (possibly stale) cache immediately rather than awaiting the
 *   refresh.
 * @remarks Primes the cache at construction so the first `@`-open is already
 *   populated.
 */
export function createWorkspaceFiles(files: WorkspaceService): () => string[] {
  let cache: string[] = [];
  let at = 0;
  let loading = false;

  function refresh(): void {
    if (loading) return;
    loading = true;
    detachObserved("workspace_file_cache_refresh", () =>
      files
        .listFiles({ limit: MAX_FILES })
        .then((entries) => {
          cache = entries.map((e) => e.path);
          at = Date.now();
        })
        .finally(() => {
          loading = false;
        }),
    );
  }
  refresh();

  return () => {
    if (Date.now() - at > FILES_TTL_MS) refresh();
    return cache;
  };
}

/** Build an image loader; missing paths are absent, operational failures remain explicit. */
export function createImageLoader(files: WorkspaceService): ImageLoader {
  return async (path: string): Promise<ImagePart | null> => {
    try {
      const { mime, data } = await files.readImage(path);
      return { type: "image", mime, data };
    } catch (error) {
      if (hasKernelErrorCode(error, "not_found")) return null;
      throw error;
    }
  };
}
