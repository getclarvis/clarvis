/** Filesystem fixtures for tests that intentionally observe persistence effects. */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

/** A fresh, isolated memory root. Callers pass it to createMemory({ root }). */
export async function makeRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "clarvis-mem-"));
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

/** Write a file under the root (creating parents), bypassing the store — used to
 * simulate a human hand-editing the tree. */
export async function seedFile(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}
