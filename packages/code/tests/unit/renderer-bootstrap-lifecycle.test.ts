import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import {
  installBootRendererLifecycle,
  type BootRendererProcess,
} from "../../src/adapters/renderer-bootstrap.ts";

class FakeProcess extends EventEmitter {
  readonly platform: NodeJS.Platform;
  readonly exits: number[] = [];

  constructor(platform: NodeJS.Platform = "linux") {
    super();
    this.platform = platform;
  }

  exit(code = 0): never {
    this.exits.push(code);
    return undefined as never;
  }
}

function harness(platform: NodeJS.Platform = "linux") {
  const host = new FakeProcess(platform);
  const keyInput = new EventEmitter();
  let destroys = 0;
  const renderer = {
    keyInput,
    destroy: () => {
      destroys += 1;
    },
  } as unknown as CliRenderer;
  const lifecycle = installBootRendererLifecycle(renderer, host as unknown as BootRendererProcess);
  return { host, keyInput, lifecycle, destroys: () => destroys };
}

function ctrlC() {
  let prevented = 0;
  let stopped = 0;
  const key = {
    name: "c",
    ctrl: true,
    preventDefault: () => {
      prevented += 1;
    },
    stopPropagation: () => {
      stopped += 1;
    },
  } as unknown as KeyEvent;
  return { key, prevented: () => prevented, stopped: () => stopped };
}

test("boot renderer lifecycle restores exactly once on a direct process exit", () => {
  const target = harness();

  target.host.emit("exit", 1);
  target.lifecycle.destroy();

  expect(target.destroys()).toBe(1);
});

test("boot renderer lifecycle owns termination signals before the platform exists", () => {
  const target = harness();

  target.host.emit("SIGTERM");

  expect(target.destroys()).toBe(1);
  expect(target.host.exits).toEqual([143]);
});

test("boot renderer lifecycle also restores on OpenTUI's catchable POSIX signals", () => {
  const target = harness();

  target.host.emit("SIGQUIT");

  expect(target.destroys()).toBe(1);
  expect(target.host.exits).toEqual([131]);
});

test("boot renderer lifecycle turns raw Ctrl+C into teardown and a conventional exit", () => {
  const target = harness();
  const key = ctrlC();

  target.keyInput.emit("keypress", key.key);

  expect(key.prevented()).toBe(1);
  expect(key.stopped()).toBe(1);
  expect(target.destroys()).toBe(1);
  expect(target.host.exits).toEqual([130]);
});

test("handoff routes Ctrl+C through the platform until the complete keymap is mounted", () => {
  const target = harness();
  let shutdowns = 0;
  const release = target.lifecycle.handoff(() => {
    shutdowns += 1;
  });
  const key = ctrlC();

  expect(target.host.listenerCount("SIGINT")).toBe(0);
  expect(target.host.listenerCount("SIGTERM")).toBe(0);
  target.keyInput.emit("keypress", key.key);
  expect(shutdowns).toBe(1);
  expect(target.destroys()).toBe(0);

  release();
  target.keyInput.emit("keypress", ctrlC().key);
  target.host.emit("exit", 0);
  expect(shutdowns).toBe(1);
  expect(target.destroys()).toBe(0);
});

test("the early exit owner remains active after signal handoff until keymap release", () => {
  const target = harness();
  target.lifecycle.handoff(() => undefined);

  target.host.emit("exit", 1);

  expect(target.destroys()).toBe(1);
});

test("Windows boot ownership omits SIGHUP", () => {
  const target = harness("win32");
  expect(target.host.listenerCount("SIGHUP")).toBe(0);
  expect(target.host.listenerCount("SIGBREAK")).toBe(1);
  target.lifecycle.destroy();
});
