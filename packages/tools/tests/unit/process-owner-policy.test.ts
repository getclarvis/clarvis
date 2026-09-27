import { expect, test } from "bun:test";
import { stopOwnedProcess, type ProcessOwnerDeps } from "#src/lib/process-owner.ts";
import { NOOP_TOOLS_LOGGER } from "#src/lib/log.ts";

function policy(runningAfter?: NodeJS.Signals) {
  let time = 0;
  let running = true;
  const signals: NodeJS.Signals[] = [];
  const deps: ProcessOwnerDeps = {
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
    isRunning: () => running,
    signal: (_owner, signal) => {
      signals.push(signal);
      if (signal === runningAfter) running = false;
    },
  };
  return { deps, signals, setRunning: (value: boolean) => (running = value), now: () => time };
}

const owner = { pid: 41, child: { exitCode: null, signalCode: null } };

test("TERM is enough when the owned tree confirms exit", async () => {
  const state = policy("SIGTERM");
  expect(await stopOwnedProcess(owner, NOOP_TOOLS_LOGGER, 1200, state.deps)).toBe(true);
  expect(state.signals).toEqual(["SIGTERM"]);
  expect(state.now()).toBe(0);
});

test("a live tree receives KILL after the unchanged 400ms grace", async () => {
  const state = policy("SIGKILL");
  expect(await stopOwnedProcess(owner, NOOP_TOOLS_LOGGER, 1200, state.deps)).toBe(true);
  expect(state.signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(state.now()).toBe(400);
});

test("signalling never substitutes for physical confirmation", async () => {
  const state = policy();
  expect(await stopOwnedProcess(owner, NOOP_TOOLS_LOGGER, 500, state.deps)).toBe(false);
  expect(state.signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(state.now()).toBe(500);
  state.setRunning(false);
  expect(await stopOwnedProcess(owner, NOOP_TOOLS_LOGGER, 500, state.deps)).toBe(true);
});
