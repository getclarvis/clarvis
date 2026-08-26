import type { ScheduleTimeout } from "../../src/timing.ts";

/** Manually-fired timeout queue for deterministic unit/component tests. */
export interface ManualTimeouts {
  schedule: ScheduleTimeout;
  fireNext(): void;
  readonly pending: number;
}

/** Build an isolated timeout queue. Cancelled entries never fire. */
export function createManualTimeouts(): ManualTimeouts {
  const tasks: Array<{ callback: () => void; cancelled: boolean }> = [];
  const next = () => tasks.find((task) => !task.cancelled);
  return {
    schedule(callback): () => void {
      const task = { callback, cancelled: false };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    fireNext(): void {
      const task = next();
      if (task === undefined) return;
      task.cancelled = true;
      task.callback();
    },
    get pending(): number {
      return tasks.filter((task) => !task.cancelled).length;
    },
  };
}
