import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/** Existing host temporary directories available to run-owned coding tools. */
export function systemTemporaryRoots(
  platform: NodeJS.Platform = process.platform,
  environmentTemporaryRoot: string = tmpdir(),
): string[] {
  const roots: string[] = [];
  for (const candidate of platform === "win32"
    ? [environmentTemporaryRoot]
    : [environmentTemporaryRoot, "/tmp"]) {
    const path = resolve(candidate);
    try {
      if (!statSync(path).isDirectory() || roots.includes(path)) continue;
    } catch {
      continue;
    }
    roots.push(path);
  }
  return roots;
}
