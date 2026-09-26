import { onTestFinished } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";

interface OwnedRoot {
  close: Array<() => void | Promise<void>>;
}

const active = new Map<string, OwnedRoot>();

/** Acquire a case-owned root and register one composed finalizer immediately. */
export function ownedTempDirSync(prefix: string): string {
  const root = mkdtempSync(prefix);
  const owner: OwnedRoot = { close: [] };
  active.set(root, owner);
  onTestFinished(async () => {
    const errors: unknown[] = [];
    for (const close of owner.close.reverse()) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `kernel fixture cleanup failed; root retained: ${root}`);
    }
    try {
      rmSync(root, { recursive: true, force: true });
      active.delete(root);
    } catch (error) {
      throw new AggregateError([error], `kernel fixture root removal failed: ${root}`, {
        cause: error,
      });
    }
  });
  return root;
}

/** Keep a kernel or transport alive under the root that acquired it. */
export function trackOwnedResource(root: string, close: () => void | Promise<void>): void {
  const owner = active.get(root);
  if (owner === undefined) throw new Error(`kernel fixture is not owned: ${root}`);
  owner.close.push(close);
}
