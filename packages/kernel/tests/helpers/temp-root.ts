import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

interface CleanupEntry {
  label: string;
  cleanup: () => void | Promise<void>;
}

export interface TempRoot {
  readonly root: string;
  path(name: string): string;
  register(label: string, cleanup: () => void | Promise<void>): () => void;
  pending(): readonly string[];
  cleanup(): Promise<void>;
}

function failure(root: string, pending: readonly string[], causes: readonly unknown[]): Error {
  return new AggregateError(
    causes,
    `temporary root cleanup failed for ${root}; pending: ${pending.join(", ") || "none"}`,
  );
}

/** Allocate one test-owned temporary root with awaited LIFO resource cleanup. */
export async function tempRoot(prefix: string): Promise<TempRoot> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resources: CleanupEntry[] = [];
  const pending = (): readonly string[] => resources.map(({ label }) => label);
  let removed = false;
  return {
    root,
    path(name) {
      if (name.length === 0 || isAbsolute(name)) throw new Error("temporary path must be relative");
      const candidate = resolve(root, name);
      const rel = relative(root, candidate);
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
        throw new Error("temporary path escapes its root");
      }
      return candidate;
    },
    register(label, cleanup) {
      if (removed) throw new Error("temporary root is already cleaned");
      const entry = { label, cleanup };
      resources.push(entry);
      return () => {
        const index = resources.indexOf(entry);
        if (index >= 0) resources.splice(index, 1);
      };
    },
    pending,
    async cleanup() {
      if (removed) return;
      const causes: unknown[] = [];
      for (let index = resources.length - 1; index >= 0; index--) {
        const entry = resources[index]!;
        try {
          await entry.cleanup();
          resources.splice(index, 1);
        } catch (error) {
          causes.push(error);
        }
      }
      if (causes.length > 0) throw failure(root, pending(), causes);
      try {
        await rm(root, { recursive: true, force: true });
        removed = true;
      } catch (error) {
        throw failure(root, pending(), [error]);
      }
    },
  };
}
