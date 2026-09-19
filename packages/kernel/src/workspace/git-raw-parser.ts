/**
 * Parsers for Git `--raw -z`, `--numstat -z`, and `ls-files -z` output.
 *
 * These formats are NUL-delimited structured records, not human `git status` lines.
 */

/** One `git diff --raw -z` record. */
export interface GitRawRecord {
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
  /** Status letter plus optional score (`M`, `A`, `R100`). */
  status: string;
  oldPath: string;
  newPath: string;
}

/** Line-count record from `git diff --numstat -z`. */
export interface GitNumstatRecord {
  oldPath: string;
  newPath: string;
  additions: number | null;
  deletions: number | null;
}

/** Split `text` on NUL without dropping a trailing empty field after the last terminator. */
function nulFields(text: string): string[] {
  if (text.length === 0) return [];
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

/**
 * Parse `git diff --raw -z` output.
 *
 * Each record is `:oldmode newmode oldsha newsha status\\0path\\0`, with a second
 * path for rename/copy.
 */
export function parseGitRawZ(output: string): GitRawRecord[] {
  const records: GitRawRecord[] = [];
  const fields = nulFields(output);
  let index = 0;
  while (index < fields.length) {
    const header = fields[index] ?? "";
    if (!header.startsWith(":")) {
      index += 1;
      continue;
    }
    const parts = header.slice(1).split(" ");
    const [oldMode, newMode, oldSha, newSha] = parts;
    if (
      oldMode === undefined ||
      newMode === undefined ||
      oldSha === undefined ||
      newSha === undefined ||
      parts.length < 5
    ) {
      index += 1;
      continue;
    }
    const status = parts.slice(4).join(" ");
    const firstPath = fields[index + 1];
    if (firstPath === undefined) break;
    const renamed = status.startsWith("R") || status.startsWith("C");
    if (renamed) {
      const secondPath = fields[index + 2];
      if (secondPath === undefined) break;
      records.push({
        oldMode,
        newMode,
        oldSha,
        newSha,
        status,
        oldPath: firstPath,
        newPath: secondPath,
      });
      index += 3;
      continue;
    }
    records.push({
      oldMode,
      newMode,
      oldSha,
      newSha,
      status,
      oldPath: firstPath,
      newPath: firstPath,
    });
    index += 2;
  }
  return records;
}

/**
 * Parse `git diff --numstat -z` output.
 *
 * A regular file is `added\\tdeleted\\tpath\\0`. A rename is
 * `added\\tdeleted\\t\\0old\\0new\\0`. Binary files use `-` for both counts.
 */
export function parseGitNumstatZ(output: string): GitNumstatRecord[] {
  const records: GitNumstatRecord[] = [];
  const fields = nulFields(output);
  let index = 0;
  while (index < fields.length) {
    const head = fields[index] ?? "";
    const tab = head.split("\t");
    if (tab.length < 2) {
      index += 1;
      continue;
    }
    const additions = tab[0] === "-" ? null : Number(tab[0]);
    const deletions = tab[1] === "-" ? null : Number(tab[1]);
    const inlinePath = tab.slice(2).join("\t");
    if (inlinePath.length > 0) {
      records.push({
        oldPath: inlinePath,
        newPath: inlinePath,
        additions: Number.isFinite(additions) ? additions : null,
        deletions: Number.isFinite(deletions) ? deletions : null,
      });
      index += 1;
      continue;
    }
    const oldPath = fields[index + 1];
    const newPath = fields[index + 2];
    if (oldPath === undefined || newPath === undefined) break;
    records.push({
      oldPath,
      newPath,
      additions: Number.isFinite(additions) ? additions : null,
      deletions: Number.isFinite(deletions) ? deletions : null,
    });
    index += 3;
  }
  return records;
}

/** Parse `git ls-files -z` (one path per record). */
export function parseGitLsFilesZ(output: string): string[] {
  return nulFields(output);
}

/**
 * Parse `git ls-files --unmerged -z`.
 *
 * Each stage is `mode sha stage\\tpath\\0`.
 */
export function parseGitUnmergedZ(output: string): string[] {
  const paths = new Set<string>();
  for (const field of nulFields(output)) {
    const tab = field.indexOf("\t");
    if (tab < 0) continue;
    const path = field.slice(tab + 1);
    if (path.length > 0) paths.add(path);
  }
  return [...paths];
}

/** Map a Git raw status letter onto the protocol operation. */
export function operationFromRaw(
  record: GitRawRecord,
):
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed"
  | "conflict"
  | "submodule" {
  if (record.oldMode === "160000" || record.newMode === "160000") return "submodule";
  const letter = record.status.charAt(0);
  if (letter === "A") return "added";
  if (letter === "D") return "deleted";
  if (letter === "R") return "renamed";
  if (letter === "C") return "copied";
  if (letter === "T") return "type_changed";
  if (letter === "U") return "conflict";
  return "modified";
}

/** Join numstat records by old/new path pair. */
export function numstatKey(oldPath: string, newPath: string): string {
  return `${oldPath}\0${newPath}`;
}
