/** Mutable callback destination owned by exactly one workspace runtime. */
export interface WorkspaceCallbackTarget<T> {
  current(): T | undefined;
  bind(value: T): void;
  clear(): void;
}

/**
 * Keep asynchronous callbacks attached to the runtime that created them.
 * Publishing another workspace never changes this target; retirement clears it.
 */
export function createWorkspaceCallbackTarget<T>(): WorkspaceCallbackTarget<T> {
  let value: T | undefined;
  return {
    current: () => value,
    bind: (next) => {
      value = next;
    },
    clear: () => {
      value = undefined;
    },
  };
}

/** True only while callbacks belong to the runtime currently published in the UI. */
export function isActiveWorkspaceCallbackTarget<T>(
  candidate: WorkspaceCallbackTarget<T>,
  published: WorkspaceCallbackTarget<T>,
): boolean {
  return candidate === published && candidate.current() !== undefined;
}
