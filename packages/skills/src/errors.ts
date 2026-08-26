/**
 * Machine-readable discriminator carried on every {@link SkillError}: an invalid
 * or duplicate skill, a missing / wrong-type path, a resource-path escape, bad
 * input, or a generic I/O failure.
 */
export type ErrorCode =
  | "invalid_skill"
  | "duplicate_skill"
  | "not_found"
  | "not_a_file"
  | "path_escape"
  | "invalid_input"
  | "io_error";

/**
 * The package's typed error: an {@link ErrorCode} plus an open bag of structured
 * `fields` for context (paths, skill names, ...) beyond the human-readable
 * message.
 */
export class SkillError extends Error {
  /** Stable machine-readable discriminator; see {@link ErrorCode}. */
  readonly code: ErrorCode;
  /** Structured context for the error (e.g. `{ path }`, `{ rel }`); defaults to empty. */
  readonly fields: Record<string, unknown>;

  /**
   * @param code - the error discriminator.
   * @param message - the human-readable message passed to `Error`.
   * @param fields - optional structured context; defaults to `{}`.
   */
  constructor(code: ErrorCode, message: string, fields: Record<string, unknown> = {}) {
    super(message);
    this.name = "SkillError";
    this.code = code;
    this.fields = fields;
  }
}

/**
 * Map a Node filesystem error to a typed {@link SkillError}, preserving the
 * offending `path` in `fields`.
 *
 * @param err - the caught `ErrnoException`.
 * @param path - the path the operation was on; recorded in the error's `fields`.
 * @returns `not_found` for `ENOENT`, `not_a_file` for `EISDIR`/`ENOTDIR`, else
 *   `io_error` carrying the original `code`/`message`.
 */
export function fsError(err: NodeJS.ErrnoException, path: string): SkillError {
  if (err.code === "ENOENT") return new SkillError("not_found", `No such file: ${path}`, { path });
  if (err.code === "EISDIR")
    return new SkillError("not_a_file", `Path is a directory: ${path}`, { path });
  if (err.code === "ENOTDIR")
    return new SkillError("not_a_file", `Not a directory: ${path}`, { path });
  return new SkillError("io_error", `${err.code ?? "EIO"}: ${err.message}`, { path });
}
