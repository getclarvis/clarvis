import { closeSync, fstatSync, openSync, opendirSync, readSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { WorkspaceEntry, WorkspaceService } from "@clarvis/protocol";
import { KernelException, kernelError } from "../core/errors.ts";
import { INTERNAL_SKIP_DIRS } from "@clarvis/paths";

/** Directory names pruned from the workspace walk (VCS, dependency, build and Clarvis-internal trees). */
const SKIP_DIRS = new Set(INTERNAL_SKIP_DIRS);

/**
 * Maximum directory depth the walk descends before stopping.
 *
 * @remarks All three bounds here serve one purpose — this walk feeds a *picker*,
 * so its job is to answer quickly with the paths a person is plausibly looking
 * for, not to enumerate a repository. Being incomplete is the designed outcome
 * rather than a failure, which is what lets each bound sit at the point where
 * more work stops improving the answer.
 *
 * Depth is bounded rather than breadth-first-truncated because the deep
 * remainder of a source tree is mostly generated or vendored, and
 * {@link SKIP_DIRS} has already removed the largest offenders. Eight levels
 * reaches past the nesting of any hand-organised source tree.
 */
const MAX_DEPTH = 8;

/**
 * Soft cap on files collected by a single walk, bounding cost on large trees.
 *
 * @remarks Sized for what a chooser can present, not for what a repository
 * holds: a list this long is already filtered by the reader rather than read,
 * so collecting more would add cost to a result nobody scrolls to the end of.
 */
const MAX_FILES = 4000;

/**
 * Maximum directory entries examined by one walk, including skipped entries.
 *
 * @remarks Separate from {@link MAX_FILES} because they fail differently: a tree
 * of many directories holding few files each can exhaust the walk's *cost*
 * without ever approaching the file cap. It is set several times the file cap so
 * that on any ordinary tree the file cap is the one that binds, and this only
 * catches the pathological shape.
 */
const MAX_ENTRIES_EXAMINED = 20_000;

/** Hard response bounds before UTF-8/base64 expansion crosses the protocol boundary. */
const MAX_WORKSPACE_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACE_IMAGE_BYTES = 7 * 1024 * 1024;

/** Best-effort image MIME type from a path's extension; defaults to `image/jpeg`. */
function mimeFromExt(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  return "image/jpeg";
}

/**
 * Resolve `path` against `root` and confirm it stays inside `root`.
 *
 * @param root - the workspace root the result must remain within.
 * @param path - an absolute path or a path relative to `root`.
 * @returns the confined absolute path, or `null` when it escapes `root` (or equals
 *   it), guarding against `..` traversal.
 */
function confinedAbs(root: string, path: string): string | null {
  const abs = isAbsolute(path) ? path : join(root, path);
  const rel = relative(root, abs);
  if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    return null;
  return abs;
}

/** Read exactly one descriptor-backed snapshot and reject a file that is or becomes oversized. */
function readBoundedFile(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw kernelError("not_found", `not a regular file: ${path}`);
    if (info.size > maxBytes) {
      throw kernelError("resource_exhausted", `file exceeds ${maxBytes} bytes`, {
        actual_bytes: info.size,
        max_bytes: maxBytes,
      });
    }
    const buffer = Buffer.allocUnsafe(Math.min(info.size + 1, maxBytes + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maxBytes) {
      throw kernelError("resource_exhausted", `file grew beyond ${maxBytes} bytes while reading`, {
        max_bytes: maxBytes,
      });
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

/**
 * Build a read-only {@link WorkspaceService} confined to `root`.
 *
 * @param root - the absolute workspace root every operation is confined to.
 * @returns a {@link WorkspaceService} that lists files (depth/count-capped,
 *   skipping {@link SKIP_DIRS} and dotdirs) and reads text/image files, rejecting
 *   any path that escapes `root`.
 */
export function createWorkspaceService(root: string): WorkspaceService {
  /**
   * Recursively collect file paths under `root`, POSIX-relative.
   *
   * @returns the workspace-relative file paths, bounded by {@link MAX_DEPTH} and
   *   {@link MAX_FILES}; unreadable dirs/entries are skipped.
   */
  function walk(): string[] {
    const out: string[] = [];
    let examined = 0;
    const recur = (dir: string, rel: string, depth: number): void => {
      if (depth > MAX_DEPTH || out.length >= MAX_FILES || examined >= MAX_ENTRIES_EXAMINED) return;
      let handle: ReturnType<typeof opendirSync>;
      try {
        handle = opendirSync(dir);
      } catch {
        return;
      }
      try {
        for (;;) {
          if (out.length >= MAX_FILES || examined >= MAX_ENTRIES_EXAMINED) break;
          const entry = handle.readSync();
          if (entry === null) break;
          examined += 1;
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
            recur(join(dir, entry.name), childRel, depth + 1);
          } else if (entry.isFile()) {
            out.push(childRel);
          }
        }
      } finally {
        handle.closeSync();
      }
    };
    recur(root, "", 0);
    return out;
  }

  return {
    /**
     * List workspace files, optionally filtered by path prefix and capped.
     *
     * @param query - optional `prefix` filter and `limit`.
     * @returns the matching {@link WorkspaceEntry}s (all `kind: "file"`).
     */
    async listFiles(query): Promise<WorkspaceEntry[]> {
      let files = walk();
      if (query?.prefix) files = files.filter((f) => f.startsWith(query.prefix!));
      const requested = query?.limit;
      const limit =
        requested === undefined || !Number.isFinite(requested)
          ? MAX_FILES
          : Math.min(MAX_FILES, Math.max(0, Math.floor(requested)));
      files = files.slice(0, limit);
      return files.map((path) => ({ path, kind: "file" }));
    },

    /**
     * Read a workspace text file as UTF-8.
     *
     * @param path - a workspace-relative (or root-confined absolute) path.
     * @returns the path and its `content`.
     * @throws {@link kernelError | KernelException} `invalid_request` when the path
     *   escapes the workspace, or `not_found` when the file cannot be read.
     */
    async readFile(path): Promise<{ path: string; content: string }> {
      const abs = confinedAbs(root, path);
      if (abs === null) throw kernelError("invalid_request", `path escapes the workspace: ${path}`);
      try {
        return { path, content: readBoundedFile(abs, MAX_WORKSPACE_TEXT_BYTES).toString("utf8") };
      } catch (e) {
        if (e instanceof KernelException) throw e;
        throw kernelError("not_found", `cannot read '${path}': ${(e as Error).message}`);
      }
    },

    /**
     * Read a workspace image file as base64.
     *
     * @param path - a workspace-relative (or root-confined absolute) path.
     * @returns the path, a best-effort `mime` (from the extension), and the
     *   base64-encoded `data`.
     * @throws {@link kernelError | KernelException} `invalid_request` when the path
     *   escapes the workspace, or `not_found` when the file cannot be read.
     */
    async readImage(path): Promise<{ path: string; mime: string; data: string }> {
      const abs = confinedAbs(root, path);
      if (abs === null) throw kernelError("invalid_request", `path escapes the workspace: ${path}`);
      try {
        return {
          path,
          mime: mimeFromExt(path),
          data: readBoundedFile(abs, MAX_WORKSPACE_IMAGE_BYTES).toString("base64"),
        };
      } catch (e) {
        if (e instanceof KernelException) throw e;
        throw kernelError("not_found", `cannot read image '${path}': ${(e as Error).message}`);
      }
    },
  };
}
