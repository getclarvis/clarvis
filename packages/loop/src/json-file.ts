import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { z } from "zod";
import { errorText } from "./error-text.ts";

/**
 * Why a {@link readJsonFile} call failed: `unreadable` (I/O error, including a
 * missing file), `parse` (invalid JSON), or `schema` (JSON that failed zod
 * validation).
 */
export type ReadJsonFileFailureKind = "unreadable" | "parse" | "schema";

/** Trust/settings sidecars are control documents, never arbitrary data blobs. */
export const MAX_JSON_CONTROL_FILE_BYTES = 2 * 1024 * 1024;

function readBoundedJson(path: string): string {
  const fd = openSync(path, "r");
  try {
    if (fstatSync(fd).size > MAX_JSON_CONTROL_FILE_BYTES)
      throw new Error(
        `file exceeds the ${String(MAX_JSON_CONTROL_FILE_BYTES)}-byte resource limit`,
      );
    const buffer = Buffer.allocUnsafe(MAX_JSON_CONTROL_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = readSync(fd, buffer, total, buffer.length - total, null);
      if (read === 0) break;
      total += read;
    }
    if (total > MAX_JSON_CONTROL_FILE_BYTES)
      throw new Error(
        `file exceeds the ${String(MAX_JSON_CONTROL_FILE_BYTES)}-byte resource limit`,
      );
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The result of {@link readJsonFile}: either `{ ok: true, value }` with the
 * validated data, or `{ ok: false, ... }` describing the failure.
 *
 * @remarks On failure, `kind` classifies it, `detail` is the raw reason, `error`
 *   is a ready-to-log message naming the path, `at` is the failing field path
 *   (schema failures only), and `missing: true` marks an absent file so callers
 *   can treat absence as a default rather than an error.
 */
export type ReadJsonFileResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      kind: ReadJsonFileFailureKind;
      detail: string;
      at?: string;
      error: string;
      missing?: true;
    };

/**
 * Read a JSON file and validate it against a zod schema in one step.
 *
 * @param path - the file to read.
 * @param schema - the zod schema the parsed JSON must satisfy.
 * @returns a {@link ReadJsonFileResult}: the validated value on success, or a
 *   failure classified by `kind` — a missing file is additionally distinguished
 *   (`missing: true`) so callers can treat absence as a default. Never throws.
 */
export function readJsonFile<T>(path: string, schema: z.ZodType<T>): ReadJsonFileResult<T> {
  let raw: string;
  try {
    raw = readBoundedJson(path);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    const detail = errorText(err);
    return {
      ok: false,
      kind: "unreadable",
      detail,
      error: `cannot read ${path}: ${detail}`,
      ...(missing ? { missing: true } : {}),
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const detail = errorText(err);
    return { ok: false, kind: "parse", detail, error: `invalid JSON in ${path}: ${detail}` };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const at = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
    return {
      ok: false,
      kind: "schema",
      detail: issue.message,
      at,
      error: `invalid ${path}: ${at}: ${issue.message}`,
    };
  }
  return { ok: true, value: parsed.data };
}
