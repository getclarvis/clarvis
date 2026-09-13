import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { CliRenderer } from "@opentui/core";
import type {
  ClipboardProcessRequest,
  ClipboardProcessResult,
} from "../../src/adapters/clipboard-process.ts";
import { createPlatform, WINDOWS_CLIPBOARD_COPY_SCRIPT } from "../../src/adapters/platform.ts";
import {
  environmentFixture,
  spyOnProcessEnv,
  spyOnProcessPlatform,
} from "../helpers/process-fixtures.ts";

let ambient: NodeJS.ProcessEnv;
let envSpy: ReturnType<typeof spyOnProcessEnv>;
let platformSpy: ReturnType<typeof spyOnProcessPlatform>;

beforeEach(() => {
  ambient = environmentFixture({
    ...process.env,
    SSH_TTY: undefined,
    SSH_CONNECTION: undefined,
    WAYLAND_DISPLAY: undefined,
    DISPLAY: ":0",
  });
  envSpy = spyOnProcessEnv(
    environmentFixture({
      ...ambient,
      SSH_TTY: undefined,
      SSH_CONNECTION: undefined,
      WAYLAND_DISPLAY: undefined,
      DISPLAY: ":0",
    }),
  );
  platformSpy = spyOnProcessPlatform("linux");
});

afterEach(() => {
  platformSpy.mockRestore();
  envSpy.mockRestore();
});

function setEnvironment(overrides: Readonly<Record<string, string | undefined>>): void {
  envSpy.mockReturnValue(environmentFixture({ ...ambient, ...overrides }));
}

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
  setEnvironment({ SSH_TTY: "/dev/pts/3" });
  let oscCalls = 0;
  const run = clipboardRunner();
  const p = createPlatform(
    fakeRenderer(true, () => oscCalls++),
    { clipboardProcess: run },
  );
  expect(await p.copyText("hello")).toBe(true);
  expect(oscCalls).toBe(1);
  expect(run).toHaveBeenCalledTimes(0);
});

test("over SSH, copyText falls back to the native tool when OSC-52 reports unsupported", async () => {
  setEnvironment({ SSH_TTY: "/dev/pts/3" });
  let oscCalls = 0;
  const run = clipboardRunner();
  const p = createPlatform(
    fakeRenderer(false, () => oscCalls++),
    { clipboardProcess: run },
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
    { clipboardProcess: run },
  );
  expect(await p.copyText("hello")).toBe(true);
  expect(run).toHaveBeenCalled();
  expect(oscCalls).toBe(0);
});

test("the Windows clipboard script sets Console.InputEncoding before reading piped stdin", async () => {
  // [Console]::OutputEncoding (set by the shared shell preamble in shell.ts)
  // only governs what PowerShell writes; reading piped stdin needs
  // InputEncoding set first, or non-ASCII clipboard text arrives as mojibake.
  expect(WINDOWS_CLIPBOARD_COPY_SCRIPT).toContain("[Console]::InputEncoding");
  expect(WINDOWS_CLIPBOARD_COPY_SCRIPT.indexOf("InputEncoding")).toBeLessThan(
    WINDOWS_CLIPBOARD_COPY_SCRIPT.indexOf("ReadToEnd"),
  );
});
