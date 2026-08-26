import type { DebugSessionController } from "../../src/adapters/debug-session.ts";

/** A `/debug` controller that records what it was asked to do and touches no disk. */
export interface FakeDebugSessionController extends DebugSessionController {
  readonly calls: string[];
  /** What `status()` should report next. */
  state: { open: boolean; path?: string; level?: "debug" | "info" | "warn" | "error" };
}

/**
 * Build a `/debug` controller fake.
 *
 * @param opened - whether a session should already read as open.
 * @returns the controller, with a `calls` log and a mutable `state`.
 */
export function fakeDebugSession(opened = false): FakeDebugSessionController {
  const calls: string[] = [];
  const controller: FakeDebugSessionController = {
    calls,
    state: opened ? { open: true, path: "/tmp/fake-debug.jsonl", level: "debug" } : { open: false },
    status: () => controller.state,
    open: (level = "debug") => {
      calls.push("open:" + level);
      const retuned = controller.state.open;
      controller.state = { open: true, path: "/tmp/fake-debug.jsonl", level };
      return { path: "/tmp/fake-debug.jsonl", level, retuned };
    },
    close: () => {
      calls.push("close");
      const path = controller.state.open ? (controller.state.path ?? null) : null;
      controller.state = { open: false };
      return path;
    },
    dispose: () => calls.push("dispose"),
  };
  return controller;
}
