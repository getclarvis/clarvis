import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { CliRenderer } from "@opentui/core";
import type {
  ClipboardProcessRequest,
  ClipboardProcessResult,
} from "../../src/adapters/clipboard-process.ts";

const stash = {
  SSH_TTY: process.env.SSH_TTY,
  SSH_CONNECTION: process.env.SSH_CONNECTION,
  DISPLAY: process.env.DISPLAY,
  WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
  platform: process.platform,
};

beforeEach(() => {
  delete process.env.SSH_TTY;
  delete process.env.SSH_CONNECTION;
  delete process.env.WAYLAND_DISPLAY;
  process.env.DISPLAY = ":0";
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});

afterEach(() => {
  for (const k of ["SSH_TTY", "SSH_CONNECTION", "DISPLAY", "WAYLAND_DISPLAY"] as const) {
    if (stash[k] === undefined) delete process.env[k];
    else process.env[k] = stash[k]!;
  }
  Object.defineProperty(process, "platform", { value: stash.platform, configurable: true });
});

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
  process.env.SSH_TTY = "/dev/pts/3";
  let oscCalls = 0;
  const run = clipboardRunner();
  const { createPlatform } = await import("../../src/adapters/platform.ts");
  const p = createPlatform(
    fakeRenderer(true, () => oscCalls++),
    { clipboardProcess: run },
  );
  expect(await p.copyText("hello")).toBe(true);
  expect(oscCalls).toBe(1);
  expect(run).toHaveBeenCalledTimes(0);
});

test("over SSH, copyText falls back to the native tool when OSC-52 reports unsupported", async () => {
  process.env.SSH_TTY = "/dev/pts/3";
  let oscCalls = 0;
  const run = clipboardRunner();
  const { createPlatform } = await import("../../src/adapters/platform.ts");
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
  const { createPlatform } = await import("../../src/adapters/platform.ts");
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
  const { WINDOWS_CLIPBOARD_COPY_SCRIPT } = await import("../../src/adapters/platform.ts");
  expect(WINDOWS_CLIPBOARD_COPY_SCRIPT).toContain("[Console]::InputEncoding");
  expect(WINDOWS_CLIPBOARD_COPY_SCRIPT.indexOf("InputEncoding")).toBeLessThan(
    WINDOWS_CLIPBOARD_COPY_SCRIPT.indexOf("ReadToEnd"),
  );
});
