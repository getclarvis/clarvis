import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const openTempDirs = new Set<string>();

export function openTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  openTempDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of openTempDirs) rmSync(dir, { recursive: true, force: true });
  openTempDirs.clear();
});
