import { constants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import { ToolError, fsError } from "../errors.ts";
import { loadIgnore } from "./ignore.ts";
import { assertWithinWorkspace } from "./paths.ts";

/** Default parallelism for batched `stat` calls (see {@link mapLimit}). */
export const STAT_CONCURRENCY = 32;

/** Keep each allocation modest while still amortizing filesystem calls. */
const READ_CHUNK_BYTES = 64 * 1024;

/** Roots against which an already-open read must still prove confinement. */
export interface ReadConfinement {
  /** Primary workspace root. */
  workspaceRoot: string;
  /** Additional read-only roots, such as the workspace state directory. */
  alsoAllow?: readonly string[];
}

/** Descriptor and confinement policy for {@link readRawFile}. */
export interface ReadFileOptions {
  /** Refuse a last-component symlink where the host exposes `O_NOFOLLOW`. */
  noFollow?: boolean;
  /** Revalidate the opened object against these roots before reading bytes. */
  confinement?: ReadConfinement;
}

/**
 * Derive the read-time confinement policy from a runtime configuration.
 *
 * @param config - the two path-confinement fields shared by every tool.
 * @param alsoAllow - additional read-only roots admitted by this particular
 *   tool (currently the workspace state tree used for output spills).
 * @returns an empty options object when confinement is disabled, otherwise the
 *   roots {@link readRawFile} must verify after opening the descriptor.
 */
export function readFileOptions(
  config: {
    readonly confineToWorkspace: boolean;
    readonly workspaceRoot: string;
    readonly temporaryRoots?: readonly string[];
  },
  alsoAllow: readonly string[] = [],
): ReadFileOptions {
  return config.confineToWorkspace
    ? {
        confinement: {
          workspaceRoot: config.workspaceRoot,
          alsoAllow: [...alsoAllow, ...(config.temporaryRoots ?? [])],
        },
      }
    : {};
}

/**
 * Open a path for a read that cannot block while identifying a POSIX FIFO.
 *
 * `O_NONBLOCK` is harmless for regular files and makes opening a FIFO return so
 * the descriptor can be rejected by `stat()` instead of waiting forever for a
 * writer. Windows does not support that flag for ordinary file opens, and its
 * filesystem paths do not expose POSIX FIFOs, so it uses Node's portable `r`
 * mode instead. `noFollow` additionally refuses a last-component symlink where
 * the host exposes `O_NOFOLLOW`; descriptor metadata remains the authority on
 * every platform.
 */
export async function openReadHandle(target: string, noFollow = false): Promise<FileHandle> {
  if (process.platform === "win32") return fs.open(target, "r");
  const flags =
    constants.O_RDONLY |
    constants.O_NONBLOCK |
    (noFollow && typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
  return fs.open(target, flags);
}

function notRegularFile(stat: Stats, relForError: string): ToolError {
  if (stat.isDirectory()) {
    return new ToolError("not_a_file", `Path is a directory: ${relForError}`, {
      path: relForError,
    });
  }
  return new ToolError("not_a_file", `Path is not a regular file: ${relForError}`, {
    path: relForError,
  });
}

function tooLargeFile(
  relForError: string,
  size: number,
  maxBytes: number,
  limitHint?: string,
): ToolError {
  const hint = limitHint ? ` (raise ${limitHint})` : "";
  return new ToolError(
    "too_large",
    `File is ${size} bytes, exceeding the ${maxBytes}-byte limit${hint}: ${relForError}`,
    { path: relForError, size, limit: maxBytes },
  );
}

/**
 * Prove that `handle` is the same file the confined pathname currently names.
 *
 * The lexical/canonical check in `resolvePath` necessarily happens before
 * `open()`. A workspace process can replace the file or any parent directory
 * with a symlink in that gap. Re-resolving after open closes that window only
 * when the result is also tied to the descriptor: otherwise a second swap
 * between `realpath()` and the read would still redirect the operation.
 * Comparing the filesystem identity (`dev` + `ino`) establishes that tie on
 * both POSIX and Windows; all bytes are then read from that same descriptor.
 */
async function assertOpenedFileConfined(
  handle: FileHandle,
  target: string,
  relForError: string,
  confinement: ReadConfinement,
): Promise<void> {
  let canonical: string;
  let opened;
  let current;
  try {
    canonical = await fs.realpath(target);
    opened = await handle.stat({ bigint: true });
    current = await fs.stat(canonical, { bigint: true });
  } catch (err) {
    throw fsError(err as NodeJS.ErrnoException, relForError);
  }

  assertWithinWorkspace(
    canonical,
    confinement.workspaceRoot,
    relForError,
    undefined,
    confinement.alsoAllow,
  );

  if (opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new ToolError(
      "path_escape",
      `Path changed while it was being opened: ${relForError}. Retry the read using a stable path ` +
        `inside the workspace.`,
      { path: relForError },
    );
  }
}

/**
 * Read at most `maxBytes + 1` bytes from an already-open regular file.
 *
 * The extra byte distinguishes an exact-boundary file from a file that grew
 * after its descriptor metadata was observed. Reads advance the descriptor's
 * own cursor (`position: null`), which works on Windows as well as POSIX and
 * keeps every byte tied to the same opened object even if the path is replaced.
 */
async function readHandleBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  while (total <= maxBytes) {
    const remaining = maxBytes - total + 1;
    const length = Math.min(READ_CHUNK_BYTES, remaining);
    const chunk = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(chunk, 0, length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }

  return Buffer.concat(chunks, total);
}

/**
 * `stat` a path and assert it is a directory.
 *
 * @param absPath - the absolute path to stat.
 * @param relForError - the workspace-relative path echoed into error messages.
 * @returns the {@link Stats} for the directory.
 * @throws a {@link ToolError} mapped from the errno failure (see
 *   {@link fsError}), or `not_a_file` when the path exists but is not a
 *   directory.
 */
export async function statDirectory(absPath: string, relForError: string): Promise<Stats> {
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch (err) {
    throw fsError(err as NodeJS.ErrnoException, relForError);
  }
  if (!stat.isDirectory()) {
    throw new ToolError("not_a_file", `Not a directory: ${relForError}`, { path: relForError });
  }
  return stat;
}

/**
 * Read a regular file into a {@link Buffer}, enforcing a byte ceiling both
 * before and during the read.
 *
 * @param target - the absolute path to read.
 * @param relForError - the workspace-relative path echoed into error messages.
 * @param maxBytes - the maximum file size to accept.
 * @param limitHint - optional name of the setting to raise, appended to the
 *   too-large message as a hint.
 * @param options - descriptor policy; `noFollow` is used for machine-owned
 *   control records whose pathname must never redirect the read, while
 *   `confinement` binds a caller-visible path to the file actually opened.
 * @returns the file contents as raw bytes (no decoding).
 * @throws a {@link ToolError} mapped from the errno failure (see
 *   {@link fsError}), `not_a_file` when the path is not a regular file, or
 *   `too_large` when the file exceeds `maxBytes`.
 * @remarks Growth after the initial descriptor stat is detected by reading one
 *   extra byte; a follow-up stat of that same descriptor supplies the most
 *   accurate size available without reopening the pathname. The handle is
 *   always closed, and a close failure is surfaced only when no earlier
 *   read/stat failure exists, preserving the primary error otherwise.
 */
export async function readRawFile(
  target: string,
  relForError: string,
  maxBytes: number,
  limitHint?: string,
  options: ReadFileOptions = {},
): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await openReadHandle(target, options.noFollow);
  } catch (err) {
    throw fsError(err as NodeJS.ErrnoException, relForError);
  }

  let contents: Buffer = Buffer.alloc(0);
  let failure: unknown;
  let failed = false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw notRegularFile(stat, relForError);
    if (options.confinement) {
      await assertOpenedFileConfined(handle, target, relForError, options.confinement);
    }
    if (stat.size > maxBytes) {
      throw tooLargeFile(relForError, stat.size, maxBytes, limitHint);
    }

    contents = await readHandleBounded(handle, maxBytes);
    if (contents.length > maxBytes) {
      const observed = await handle.stat().catch(() => undefined);
      const size = Math.max(contents.length, observed?.size ?? 0);
      throw tooLargeFile(relForError, size, maxBytes, limitHint);
    }
  } catch (err) {
    failed = true;
    failure = err;
  }

  try {
    await handle.close();
  } catch (err) {
    if (!failed) {
      failed = true;
      failure = err;
    }
  }

  if (failed) {
    if (failure instanceof ToolError) throw failure;
    throw fsError(failure as NodeJS.ErrnoException, relForError);
  }
  return contents;
}

/**
 * Map `fn` over `items` with bounded concurrency, preserving input order in the
 * result.
 *
 * @param items - the inputs to process.
 * @param limit - the maximum number of `fn` calls in flight at once.
 * @param fn - the async transform applied to each item.
 * @returns the results, index-aligned to `items`.
 * @remarks The first rejection propagates (via `Promise.all`); remaining
 *   in-flight work still settles but its results are discarded.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Glob files under `base`, optionally filtering out git-ignored paths.
 *
 * @param base - the directory the glob is rooted at.
 * @param workspaceRoot - the workspace root used to resolve `.gitignore` rules.
 * @param opts - `pattern` is the glob (dotfiles included, files only);
 *   `respectGitignore` toggles the ignore filter.
 * @returns matching absolute paths plus whether the traversal ceiling stopped
 *   discovery before the tree was exhausted.
 * @remarks When `respectGitignore` is set, the ignore matcher is evaluated
 *   against each match's path relative to `workspaceRoot`, so ignore rules
 *   anywhere between the workspace root and the file apply.
 */
export interface FileListing {
  files: string[];
  truncated: boolean;
}

export async function listFiles(
  base: string,
  workspaceRoot: string,
  opts: {
    pattern: string;
    respectGitignore: boolean;
    maxEntries?: number;
    signal?: AbortSignal;
  },
): Promise<FileListing> {
  const maxEntries = Math.max(1, opts.maxEntries ?? Number.MAX_SAFE_INTEGER);
  const matches = picomatch(opts.pattern, { dot: true, windows: false });
  const ig = opts.respectGitignore ? loadIgnore(workspaceRoot) : null;
  const files: string[] = [];
  const stack = [base];
  let visited = 0;
  let truncated = false;

  scan: while (stack.length > 0) {
    if (visited >= maxEntries || opts.signal?.aborted) {
      truncated = true;
      break;
    }
    const dir = stack.pop()!;
    let handle;
    try {
      handle = await fs.opendir(dir);
    } catch {
      continue;
    }
    try {
      for await (const entry of handle) {
        if (visited >= maxEntries || opts.signal?.aborted) {
          truncated = true;
          break scan;
        }
        visited += 1;
        const abs = path.join(dir, entry.name);
        const workspaceRel = path.relative(workspaceRoot, abs);
        if (entry.isDirectory()) {
          if (ig?.ignores(`${workspaceRel}${path.sep}`) !== true) stack.push(abs);
          continue;
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        const baseRel = path.relative(base, abs).split(path.sep).join("/");
        if (matches(baseRel) && ig?.ignores(workspaceRel) !== true) files.push(abs);
      }
    } finally {
      await Promise.resolve(handle.close()).catch(() => undefined);
    }
  }
  return { files, truncated };
}
