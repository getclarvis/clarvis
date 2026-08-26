import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A temporary workspace whose cleanup is safe to call more than once. */
export interface TempWorkspace {
  dir: string;
  cleanup(): Promise<void>;
}

/** Allocate an integration workspace and return its teardown beside it. */
export async function createTempWorkspace(prefix: string): Promise<TempWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
