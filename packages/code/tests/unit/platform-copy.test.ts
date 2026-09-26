import { expect, mock, test } from "bun:test";
import type { CliRenderer } from "@opentui/core";
import type {
  ClipboardProcessRequest,
  ClipboardProcessResult,
} from "../../src/adapters/clipboard-process.ts";
import { createPlatform } from "../../src/adapters/platform.ts";
const localEnvironment: NodeJS.ProcessEnv = { DISPLAY: ":0" };

function fakeRenderer(oscResult: boolean, onOsc?: () => void) {
  return {
    capabilities: { osc52: true, rgb: true },
    useMouse: false,
    themeMode: "dark",
    on: () => {},
    waitForThemeMode: () => Promise.resolve("dark"),
    copyToClipboardOSC52: (_text: string): boolean => {
      onOsc?.();
      return oscResult;
    },
    destroy: () => {},
    suspend: () => {},
    resume: () => {},
  } as unknown as CliRenderer;
}

function okCopy(): ClipboardProcessResult {
  return {
    exitCode: 0,
    stdout: Buffer.alloc(0),
    stderr: "",
    timedOut: false,
    cancelled: false,
    outputExceeded: false,
  };
}

function clipboardRunner(
  impl: (
    request: ClipboardProcessRequest,
  ) => ClipboardProcessResult | Promise<ClipboardProcessResult> = () => okCopy(),
) {
  return mock(async (request: ClipboardProcessRequest) => impl(request));
}

test("over SSH, copyText tries OSC-52 first and skips the native tool when it succeeds", async () => {
  let oscCalls = 0;
  const run = clipboardRunner();
  const p = createPlatform(
    fakeRenderer(true, () => oscCalls++),
    { clipboardProcess: run, processEnv: () => ({ ...localEnvironment, SSH_TTY: "/dev/pts/3" }) },
  );
  expect(await p.copyText("hello")).toBe(true);
  expect(oscCalls).toBe(1);
  expect(run).toHaveBeenCalledTimes(0);
});

test("over SSH, copyText falls back to the native tool when OSC-52 reports unsupported", async () => {
  let oscCalls = 0;
  const run = clipboardRunner();
  const p = createPlatform(
    fakeRenderer(false, () => oscCalls++),
    { clipboardProcess: run, processEnv: () => ({ ...localEnvironment, SSH_TTY: "/dev/pts/3" }) },
  );
  expect(await p.copyText("hello")).toBe(true);
  expect(oscCalls).toBe(1);
  expect(run).toHaveBeenCalled();
});

test("locally, copyText prefers the native tool and never emits OSC-52 when it succeeds", async () => {
  let oscCalls = 0;
  const run = clipboardRunner();
  const p = createPlatform(
    fakeRenderer(true, () => oscCalls++),
    { clipboardProcess: run, processEnv: () => localEnvironment },
  );
  expect(await p.copyText("hello")).toBe(true);
  expect(run).toHaveBeenCalled();
  expect(oscCalls).toBe(0);
});
