import type { LoopClock } from "../../src/core/loop-schedule.ts";

export class TestLoopClock implements LoopClock {
  wall = Date.parse("2026-01-01T10:00:00Z");
  monotonic = 0;
  sequence = 0;
  wakes = new Map<number, { at: number; callback: () => void }>();
  now = (): number => this.wall;
  elapsed = (): number => this.monotonic;
  wake = (callback: () => void, delay: number): (() => void) => {
    const id = ++this.sequence;
    this.wakes.set(id, { at: this.monotonic + delay, callback });
    return () => {
      this.wakes.delete(id);
    };
  };
  async advance(elapsed: number, wall = elapsed): Promise<void> {
    this.monotonic += elapsed;
    this.wall += wall;
    for (let i = 0; i < 20; i++) {
      const due = [...this.wakes].filter(([, entry]) => entry.at <= this.monotonic);
      for (const [id, entry] of due) {
        this.wakes.delete(id);
        entry.callback();
      }
      await Promise.resolve();
    }
  }
}
