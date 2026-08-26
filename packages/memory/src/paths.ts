/**
 * Document-key normalization for the memory tree.
 *
 * Every {@link MemoryStore} adapter funnels caller-supplied paths through
 * {@link normalizeMemoryPath}, so a key is byte-identical whichever backend
 * stores it — `a//b.md`, `./a/b.md` and `a\b.md` all resolve to the same
 * document. This module is pure: `node:path`'s POSIX helpers are string
 * operations, not I/O.
 */
import * as path from "node:path";

import type { DocKind } from "./types.ts";

/**
 * Thrown when a caller-supplied memory path is absolute, escapes the tree, or is
 * not a `.md` document.
 */
export class MemoryPathError extends Error {
  /** Stable machine-readable discriminator, `"memory_path_invalid"`. */
  readonly code = "memory_path_invalid";

  constructor(message: string) {
    super(message);
    this.name = "MemoryPathError";
  }
}

/**
 * Validate and POSIX-normalize a caller-supplied relative document path.
 *
 * @param relPath - the path to normalize, relative to the memory root.
 * @returns the POSIX-normalized relative path.
 * @throws {@link MemoryPathError} when the path is absolute, escapes the root
 *   through `..`, or does not name a `.md` document.
 */
export function normalizeMemoryPath(relPath: string): string {
  const posix = relPath.replace(/\\/g, "/");
  if (posix.startsWith("/")) {
    throw new MemoryPathError(`memory: path must be relative: ${relPath}`);
  }
  const normalized = path.posix.normalize(posix);
  if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new MemoryPathError(`memory: path escapes the memory root: ${relPath}`);
  }
  if (!normalized.endsWith(".md")) {
    throw new MemoryPathError(`memory: only .md documents are allowed: ${relPath}`);
  }
  return normalized;
}

/**
 * Order two document keys.
 *
 * @param a - the first key.
 * @param b - the second key.
 * @returns a negative number, zero, or a positive number, per `Array.sort`.
 * @remarks Compares by UTF-16 code unit, deliberately **not** `localeCompare`:
 *   listing order is part of the port's contract (it drives the generated
 *   navigation blocks), so it must not vary with the host's locale, and a
 *   database ordering by its key column must be able to reproduce it.
 */
export function compareMemoryPaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Classify a document by its basename: `PROFILE.md` is the root compilation,
 * `TOPIC.md` a domain compilation, anything else a detail leaf.
 *
 * @param relPath - a tree-relative document path.
 * @returns the document's {@link DocKind}.
 */
export function memoryDocKind(relPath: string): DocKind {
  const base = path.posix.basename(relPath);
  if (base === "PROFILE.md") return "profile";
  if (base === "TOPIC.md") return "topic";
  return "memory";
}
