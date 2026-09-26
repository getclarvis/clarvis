import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

/** Canonicalize a target through its nearest existing ancestor without requiring the target to exist. */
export function canonicalTarget(path: string): string | undefined {
  let parent = dirname(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(parent), ...missing, basename(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      const ancestor = dirname(parent);
      if (ancestor === parent) return undefined;
      missing.unshift(basename(parent));
      parent = ancestor;
    }
  }
}
