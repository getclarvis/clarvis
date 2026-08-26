/**
 * A scriptable stand-in for a spawned child, plus a controllable clock.
 *
 * The point of both is that the interesting paths in `runHookCommand` -
 * truncation, the exit/close race, timeout escalating to SIGKILL, a broken stdin
 * pipe - are all reachable without a real process and without a real wait.
 * `monitor-spawn.test.ts` and `monitor-stop-kill.test.ts` in `@clarvis/tools`
 * are the precedent for the spawn and kill seams; the clock is the piece those
 * lack, which is why they pay the real grace period on every run.
 */
import { EventEmitter } from "node:events";
import type { HookSpawnOptions, SpawnFn, TimerDeps } from "../../src/subprocess.ts";

class FakeStream extends EventEmitter {
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeStdin extends EventEmitter {
  written: string | null = null;
  /** When true, `end` emits EPIPE - which throws unless someone is listening. */
  epipe = false;
  end(data: string, _encoding: BufferEncoding): void {
    this.written = data;
    if (this.epipe) this.emit("error", new Error("write EPIPE"));
    else this.emit("close");
  }
}

/** A child process whose entire lifecycle the test drives. */
export class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  stdin: FakeStdin | null = new FakeStdin();
  pid: number | undefined = 4242;
  readonly kills: NodeJS.Signals[] = [];
  unrefs = 0;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    return true;
  }
  unref(): void {
    this.unrefs += 1;
  }

  out(text: string): void {
    this.stdout.emit("data", Buffer.from(text, "utf8"));
  }
  err(text: string): void {
    this.stderr.emit("data", Buffer.from(text, "utf8"));
  }
  /** Emits `exit` then `close`, the ordinary ending. */
  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
  /** Emits `exit` only, leaving `close` outstanding so the drain timer decides. */
  exitOnly(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
  /** Emits `close` only, leaving `exit` outstanding so the drain timer decides. */
  closeOnly(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("close", code, signal);
  }
  fail(message: string): void {
    this.emit("error", new Error(message));
  }
}

/** What one spawn was asked to do. */
export interface SpawnCall {
  file: string;
  args: readonly string[];
  options: HookSpawnOptions;
}

/**
 * A `spawn` seam that hands back `child` and records the call.
 *
 * @param child - the double to return, or a factory for one per call.
 * @param calls - populated with every invocation.
 */
export function fakeSpawn(child: FakeChild | (() => FakeChild), calls: SpawnCall[] = []): SpawnFn {
  return (file, args, options) => {
    calls.push({ file, args, options });
    return typeof child === "function" ? child() : child;
  };
}

/** A `TimerDeps` whose clock only moves when the test says so. */
export interface FakeClock {
  timers: TimerDeps;
  now(): number;
  advance(ms: number): void;
  pending(): number;
}

/** Builds a {@link FakeClock} starting at t=0. */
export function fakeClock(): FakeClock {
  const scheduled = new Map<number, { fn: () => void; at: number }>();
  let nextHandle = 0;
  let current = 0;
  return {
    timers: {
      setTimeout(fn, ms) {
        const handle = ++nextHandle;
        scheduled.set(handle, { fn, at: current + ms });
        return handle;
      },
      clearTimeout(handle) {
        scheduled.delete(handle as number);
      },
    },
    now: () => current,
    advance(ms) {
      current += ms;
      for (;;) {
        const due = [...scheduled.entries()]
          .filter(([, t]) => t.at <= current)
          .sort((a, b) => a[1].at - b[1].at);
        const first = due[0];
        if (first === undefined) break;
        scheduled.delete(first[0]);
        first[1].fn();
      }
    },
    pending: () => scheduled.size,
  };
}

/** Lets pending microtasks and immediates run, so emitted events are observed. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
