/**
 * Resolving the source product root and private host entry.
 *
 * @remarks
 * The launcher in `cli.ts` is invisible to coverage — Bun instruments only the
 * test process, and `coverage.ts` allowlists the file for that reason —
 * so the decision lives here, as a pure function over already-gathered facts,
 * and the launcher only performs it.
 *
 * The launcher keeps ordinary flags independent of application loading.
 */

import { dirname, join, resolve, sep } from "node:path";

/** Resolve the checkout or portable release containing this source launcher. */
export function productRootForEntry(entryPath: string): string {
  const directory = dirname(resolve(entryPath));
  const layout = join("packages", "code", "src");
  if (!directory.endsWith(`${sep}${layout}`)) {
    throw new Error("Clarvis entry is outside its product root");
  }
  return resolve(directory.slice(0, -layout.length));
}

/** Private process entry selected before ordinary user-facing argument parsing. */
export function privateEntry(argv: readonly string[]): "remote-kernel" | undefined {
  return argv[0] === "--remote-kernel" ? "remote-kernel" : undefined;
}
