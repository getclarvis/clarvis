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

export interface TempRootDeps {
  makeRoot?: (prefix: string) => Promise<string>;
  removeRoot?: (root: string) => Promise<void>;
}

function cleanupError(root: string, pending: readonly string[], causes: readonly unknown[]): Error {
  const labels = pending.length === 0 ? "none" : pending.join(", ");
  return new AggregateError(
    causes,
    `temporary root cleanup failed for ${root}; pending: ${labels}`,
  );
}

/** Allocate one test-owned temporary root with awaited LIFO resource cleanup. */
export async function tempRoot(prefix: string, deps: TempRootDeps = {}): Promise<TempRoot> {
  const makeRoot = deps.makeRoot ?? ((value) => mkdtemp(join(tmpdir(), value)));
  const removeRoot = deps.removeRoot ?? ((root) => rm(root, { recursive: true, force: true }));
  const root = await makeRoot(prefix);
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
      const failures: unknown[] = [];
      for (let index = resources.length - 1; index >= 0; index--) {
        const entry = resources[index]!;
        try {
          await entry.cleanup();
          resources.splice(index, 1);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw cleanupError(root, pending(), failures);

      try {
        await removeRoot(root);
        removed = true;
      } catch (error) {
        throw cleanupError(root, pending(), [error]);
      }
    },
  };
}
