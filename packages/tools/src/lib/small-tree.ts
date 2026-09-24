import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { ToolError, fsError } from "../errors.ts";

/** Upper bounds keep a recursive deletion review readable and its wire frame small. */
export const SMALL_TREE_MAX_ENTRIES = 64;
export const SMALL_TREE_MAX_PATH_BYTES = 8_192;

export interface SmallTreeSnapshot {
  readonly entries: readonly string[];
  readonly revision: string;
}

/** Capture a small directory tree without reading file bodies or following links. */
export function scanSmallTree(root: string): SmallTreeSnapshot {
  if (!isAbsolute(root)) throw new ToolError("invalid_input", "Tree root must be absolute.");
  const entries: string[] = [];
  const records: string[] = [];
  let pathBytes = 0;
  const visit = (path: string, depth: number): void => {
    if (depth > 32)
      throw new ToolError("too_large", "Directory tree exceeds the cleanup depth limit.");
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink())
      throw new ToolError("denied", "Recursive cleanup refuses symbolic links in the tree.");
    if (depth === 0 && !stat.isDirectory())
      throw new ToolError("invalid_input", "Recursive cleanup requires a directory.");
    if (!stat.isDirectory() && !stat.isFile())
      throw new ToolError(
        "denied",
        "Recursive cleanup supports only regular files and directories.",
      );
    const name = relative(root, path) || ".";
    if (
      [...name].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return (
          code < 32 ||
          code === 127 ||
          (code >= 0x200b && code <= 0x200f) ||
          (code >= 0x202a && code <= 0x202e) ||
          (code >= 0x2066 && code <= 0x2069)
        );
      })
    )
      throw new ToolError("denied", "Recursive cleanup cannot safely preview this file name.");
    pathBytes += Buffer.byteLength(name);
    if (entries.length + 1 > SMALL_TREE_MAX_ENTRIES || pathBytes > SMALL_TREE_MAX_PATH_BYTES)
      throw new ToolError("too_large", "Directory tree exceeds the bounded cleanup preview.");
    entries.push(name);
    records.push(
      JSON.stringify([
        name,
        stat.dev.toString(),
        stat.ino.toString(),
        stat.mode.toString(),
        stat.size.toString(),
        stat.mtimeNs.toString(),
        stat.ctimeNs.toString(),
      ]),
    );
    if (stat.isDirectory()) {
      const children = readdirSync(path).sort();
      for (const child of children) {
        const candidate = join(path, child);
        const local = relative(root, candidate);
        if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`))
          throw new ToolError("denied", "Directory tree escaped its cleanup root.");
        visit(candidate, depth + 1);
      }
    }
  };
  try {
    visit(root, 0);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw fsError(error as NodeJS.ErrnoException, root);
  }
  return {
    entries,
    revision: createHash("sha256").update(records.join("\n")).digest("hex"),
  };
}
