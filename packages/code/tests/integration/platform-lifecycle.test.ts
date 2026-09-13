import { afterEach, beforeEach, expect, mock, test, vi } from "bun:test";

const spyOn = vi.spyOn;
import type { CliRenderer } from "@opentui/core";
import type {
  ClipboardProcessRequest,
  ClipboardProcessResult,
} from "../../src/adapters/clipboard-process.ts";
import {
  assertInteractiveTTY,
  buildRendererConfig,
  createPlatform,
  readClipboardImage,
} from "../../src/adapters/platform.ts";
import {
  environmentFixture,
  spyOnProcessEnv,
  spyOnProcessPlatform,
} from "../helpers/process-fixtures.ts";

process.setMaxListeners(0);

let ambient: NodeJS.ProcessEnv;
let envSpy: ReturnType<typeof spyOnProcessEnv>;
let platformSpy: ReturnType<typeof spyOnProcessPlatform>;

beforeEach(() => {
  ambient = environmentFixture({
    ...process.env,
    SSH_TTY: undefined,
    SSH_CONNECTION: undefined,
    WAYLAND_DISPLAY: undefined,
    DISPLAY: undefined,
    NO_COLOR: undefined,
    TERM_PROGRAM: undefined,
  });
  envSpy = spyOnProcessEnv(
    environmentFixture({
      ...ambient,
      SSH_TTY: undefined,
      SSH_CONNECTION: undefined,
      WAYLAND_DISPLAY: undefined,
      DISPLAY: undefined,
      NO_COLOR: undefined,
      TERM_PROGRAM: undefined,
    }),
  );
  platformSpy = spyOnProcessPlatform("linux");
});

afterEach(() => {
  platformSpy.mockRestore();
  envSpy.mockRestore();
});

function setEnvironment(overrides: Readonly<Record<string, string | undefined>>): void {
  envSpy.mockReturnValue(Object.freeze({ ...ambient, ...overrides }) as NodeJS.ProcessEnv);
}

function setPlatform(platform: NodeJS.Platform): void {
  platformSpy.mockReturnValue(platform);
}

function okResult(stdout: Buffer = Buffer.alloc(0)): ClipboardProcessResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
    cancelled: false,
    outputExceeded: false,
  };
}

function failResult(error?: Error): ClipboardProcessResult {
  return {
    exitCode: null,
    stdout: Buffer.alloc(0),
    stderr: "",
    timedOut: false,
    cancelled: false,
    outputExceeded: false,
    error: error ?? new Error("ENOENT"),
  };
}

function clipboardRunner(
  impl: (
    request: ClipboardProcessRequest,
  ) => ClipboardProcessResult | Promise<ClipboardProcessResult> = () => okResult(),
) {
  return mock(async (request: ClipboardProcessRequest) => impl(request));
}

function fakeStream(isTTY: boolean): NodeJS.ReadStream & NodeJS.WriteStream {
  return { isTTY } as unknown as NodeJS.ReadStream & NodeJS.WriteStream;
}

test("assertInteractiveTTY: both stdin and stdout are TTYs -> no exit, no stderr write", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  const errSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  assertInteractiveTTY({ stdin: fakeStream(true), stdout: fakeStream(true) });
  expect(exitSpy).not.toHaveBeenCalled();
  expect(errSpy).not.toHaveBeenCalled();
  exitSpy.mockRestore();
  errSpy.mockRestore();
});

test("assertInteractiveTTY: non-TTY stdout writes guidance to stderr and exits with code 2", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  const errSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  assertInteractiveTTY({ stdin: fakeStream(true), stdout: fakeStream(false) });
  expect(exitSpy).toHaveBeenCalledWith(2);
  expect(errSpy.mock.calls[0]![0]).toContain("interactive TUI");
  exitSpy.mockRestore();
  errSpy.mockRestore();
});

test("assertInteractiveTTY: non-TTY stdin also exits with code 2", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  const errSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  assertInteractiveTTY({ stdin: fakeStream(false), stdout: fakeStream(true) });
  expect(exitSpy).toHaveBeenCalledWith(2);
  exitSpy.mockRestore();
  errSpy.mockRestore();
});

test("assertInteractiveTTY: falls back to process.stdin/process.stdout when no io is given", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  const errSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  assertInteractiveTTY();
  expect(exitSpy).toHaveBeenCalledWith(2);
  if (stdinDesc) Object.defineProperty(process.stdin, "isTTY", stdinDesc);
  if (stdoutDesc) Object.defineProperty(process.stdout, "isTTY", stdoutDesc);
  exitSpy.mockRestore();
  errSpy.mockRestore();
});

test("buildRendererConfig: default opts keep openConsoleOnError off", async () => {
  const cfg = buildRendererConfig();
  expect(cfg.openConsoleOnError).toBe(false);
  expect(cfg.consoleMode).toBe("disabled");
  expect(cfg.screenMode).toBe("alternate-screen");
  expect(cfg.exitOnCtrlC).toBe(false);
  expect(cfg.useKittyKeyboard).toEqual({});
  expect(cfg.prependInputHandlers).toBeUndefined();
  expect(cfg.useMouse).toBe(true);
  expect(cfg.targetFps).toBe(30);
  expect(cfg.maxFps).toBe(60);
});

test("buildRendererConfig: direct macOS iTerm preserves native text composition", async () => {
  setPlatform("darwin");
  setEnvironment({ TERM_PROGRAM: "iTerm.app" });
  const cfg = buildRendererConfig();

  expect(cfg.useKittyKeyboard).toEqual({});
  expect(cfg.prependInputHandlers).toBeUndefined();
});

test("buildRendererConfig: dev:true turns openConsoleOnError on", async () => {
  const cfg = buildRendererConfig({ dev: true });
  expect(cfg.openConsoleOnError).toBe(true);
  expect(cfg.consoleMode).toBe("console-overlay");
});

interface FakeRendererOpts {
  themeMode?: "dark" | "light";
  capabilities?: Record<string, unknown> | undefined;
  useMouse?: boolean;
  oscResult?: boolean;
  throwOnOsc?: boolean;
  detectedTheme?: "dark" | "light";
  throwOnSuspend?: boolean;
  throwOnResume?: boolean;
  throwOnDestroy?: boolean;
}

function fakeRenderer(opts: FakeRendererOpts = {}) {
  const handlers = new Map<string, (mode: "dark" | "light") => void>();
  return {
    themeMode: opts.themeMode ?? "dark",
    capabilities: opts.capabilities,
    useMouse: opts.useMouse ?? true,
    on: (event: string, cb: (mode: "dark" | "light") => void) => {
      handlers.set(event, cb);
    },
    emit: (event: string, mode: "dark" | "light") => handlers.get(event)?.(mode),
    waitForThemeMode: () => Promise.resolve(opts.detectedTheme),
    copyToClipboardOSC52: (): boolean => {
      if (opts.throwOnOsc) throw new Error("osc52 failed");
      return opts.oscResult ?? true;
    },
    destroy: () => {
      if (opts.throwOnDestroy) throw new Error("destroy failed");
    },
    suspend: () => {
      if (opts.throwOnSuspend) throw new Error("suspend failed");
    },
    resume: () => {
      if (opts.throwOnResume) throw new Error("resume failed");
    },
  } as unknown as CliRenderer & { emit: (event: string, mode: "dark" | "light") => void };
}

test("createPlatform: capabilities reflect the renderer's reported flags", async () => {
  const renderer = fakeRenderer({
    capabilities: { kitty_keyboard: true, osc52: true, multiplexer: "tmux", rgb: true },
    useMouse: true,
  });
  const p = createPlatform(renderer);
  expect(p.capabilities.keyboard()).toBe("kitty");
  expect(p.capabilities.mouse()).toBe(true);
  expect(p.capabilities.clipboard.osc52()).toBe(true);
  expect(p.capabilities.multiplexer()).toBe("tmux");
  expect(p.capabilities.colorDepth()).toBe("truecolor");
});

test("createPlatform: reports the client runtime, remote path, and terminal identity", async () => {
  setEnvironment({ SSH_CONNECTION: "client server" });
  const renderer = fakeRenderer({
    capabilities: { terminal: { name: "kitty", version: "0.42" } },
  });
  const p = createPlatform(renderer);

  expect(p.capabilities.remote()).toBe(true);
  expect(p.capabilities.terminal()).toEqual({ name: "kitty", version: "0.42" });
  expect(p.capabilities.runtimePlatform()).toBe("linux");
  setPlatform("darwin");
  expect(p.capabilities.runtimePlatform()).toBe("macos");
  setPlatform("win32");
  expect(p.capabilities.runtimePlatform()).toBe("windows");
  setPlatform("aix");
  expect(p.capabilities.runtimePlatform()).toBe("unknown");
});

test("createPlatform: missing capability flags fall back to legacy keyboard, no mouse, no osc52, 'none' multiplexer", async () => {
  const renderer = fakeRenderer({ capabilities: undefined, useMouse: false });
  const p = createPlatform(renderer);
  expect(p.capabilities.keyboard()).toBe("legacy");
  expect(p.capabilities.mouse()).toBe(false);
  expect(p.capabilities.clipboard.osc52()).toBe(false);
  expect(p.capabilities.multiplexer()).toBe("none");
});

test("createPlatform: colorDepth prefers ansi256 over 16-color, and NO_COLOR forces mono", async () => {
  const ansi = createPlatform(fakeRenderer({ capabilities: { rgb: false, ansi256: true } }));
  expect(ansi.capabilities.colorDepth()).toBe("256");

  const plain = createPlatform(fakeRenderer({ capabilities: { rgb: false, ansi256: false } }));
  expect(plain.capabilities.colorDepth()).toBe("16");

  setEnvironment({ NO_COLOR: "1" });
  const forced = createPlatform(fakeRenderer({ capabilities: { rgb: true } }));
  expect(forced.capabilities.colorDepth()).toBe("mono");
});

test("createPlatform: themeBg tracks the renderer's 'theme_mode' event", async () => {
  const renderer = fakeRenderer({ themeMode: "dark" });
  const p = createPlatform(renderer);
  expect(p.capabilities.themeBg()).toBe("dark");
  (renderer as unknown as { emit: (e: string, m: "dark" | "light") => void }).emit(
    "theme_mode",
    "light",
  );
  expect(p.capabilities.themeBg()).toBe("light");
});

test("createPlatform: capability revisions and asynchronous theme detection stay live", async () => {
  const renderer = fakeRenderer({ themeMode: "dark", detectedTheme: "light" });
  const p = createPlatform(renderer);
  expect(p.capabilities.revision()).toBe(0);
  renderer.emit("capabilities", "dark");
  expect(p.capabilities.revision()).toBe(1);
  await Promise.resolve();
  await Promise.resolve();
  expect(p.capabilities.themeBg()).toBe("light");
});

test("createPlatform: rejects malformed and non-web URLs and contains an OSC-52 failure", async () => {
  const p = createPlatform(fakeRenderer({ throwOnOsc: true }), {
    clipboardProcess: clipboardRunner(() => failResult()),
  });
  expect(await p.openUrl?.("not a URL")).toBe(false);
  expect(await p.openUrl?.("file:///tmp/private")).toBe(false);
  expect(await p.copyText("hello")).toBe(false);
});

test("createPlatform: onShutdown registers a hook and its unregister function removes it", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  const p = createPlatform(fakeRenderer());
  let called = 0;
  const unregister = p.onShutdown(() => {
    called++;
  });
  unregister();
  await p.shutdown("user-quit");
  expect(called).toBe(0);
  exitSpy.mockRestore();
});

test("createPlatform: shutdown runs hooks in reverse-registration order and exits 0 for a non-panic reason", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  const renderer = fakeRenderer();
  const destroySpy = spyOn(renderer, "destroy");
  const p = createPlatform(renderer);
  const order: string[] = [];
  p.onShutdown(() => {
    order.push("first");
  });
  p.onShutdown(() => {
    order.push("second");
  });
  await p.shutdown("user-quit");
  expect(order).toEqual(["second", "first"]);
  expect(destroySpy).toHaveBeenCalled();
  expect(exitSpy).toHaveBeenCalledWith(0);
  exitSpy.mockRestore();
});

test("createPlatform: fatal boot shutdown restores the renderer and exits 1", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  const renderer = fakeRenderer();
  const destroySpy = spyOn(renderer, "destroy");
  const p = createPlatform(renderer);
  await p.shutdown("boot-failed");
  expect(destroySpy).toHaveBeenCalledTimes(1);
  expect(exitSpy).toHaveBeenCalledWith(1);
  exitSpy.mockRestore();
});

test("createPlatform: shutdown tolerates a throwing/rejecting hook without failing the run", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  const p = createPlatform(fakeRenderer());
  p.onShutdown(() => {
    throw new Error("boom");
  });
  p.onShutdown(async () => {
    await Promise.reject(new Error("also boom"));
  });
  await expect(p.shutdown("user-quit")).resolves.toBeUndefined();
  expect(exitSpy).toHaveBeenCalledWith(0);
  exitSpy.mockRestore();
});

test("createPlatform: shutdown cancels an in-flight clipboard helper", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  setEnvironment({ DISPLAY: ":0" });
  let aborted = false;
  const clipboardProcess = mock(
    (request: { signal?: AbortSignal }) =>
      new Promise<{
        exitCode: null;
        stdout: Buffer;
        stderr: string;
        timedOut: false;
        cancelled: true;
        outputExceeded: false;
      }>((resolve) => {
        request.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve({
              exitCode: null,
              stdout: Buffer.alloc(0),
              stderr: "",
              timedOut: false,
              cancelled: true,
              outputExceeded: false,
            });
          },
          { once: true },
        );
      }),
  );
  const p = createPlatform(fakeRenderer({ oscResult: false }), { clipboardProcess });
  const copy = p.copyText("hello");
  await p.shutdown("user-quit");
  expect(aborted).toBe(true);
  expect(await copy).toBe(false);
  exitSpy.mockRestore();
});

test("createPlatform: a panic reason with an error writes the stack to stderr and exits 1", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  const errSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  const p = createPlatform(fakeRenderer());
  await p.shutdown("panic", new Error("kaboom"));
  expect(exitSpy).toHaveBeenCalledWith(1);
  expect(errSpy.mock.calls.some((c) => String(c[0]).includes("kaboom"))).toBe(true);
  exitSpy.mockRestore();
  errSpy.mockRestore();
});

test("createPlatform: a panic reason without an error writes nothing extra to stderr and still exits 1", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  const errSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  const p = createPlatform(fakeRenderer());
  await p.shutdown("panic");
  expect(exitSpy).toHaveBeenCalledWith(1);
  expect(errSpy).not.toHaveBeenCalled();
  exitSpy.mockRestore();
  errSpy.mockRestore();
});

test("createPlatform: a second concurrent shutdown call short-circuits straight to restore + exit", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  const renderer = fakeRenderer();
  const destroySpy = spyOn(renderer, "destroy");
  const p = createPlatform(renderer);
  const first = p.shutdown("user-quit");
  const second = p.shutdown("signal:SIGTERM");
  await Promise.all([first, second]);
  expect(destroySpy).toHaveBeenCalled();
  expect(exitSpy).toHaveBeenCalledWith(0);
  exitSpy.mockRestore();
});

test("createPlatform: a concurrent signal cannot downgrade a fatal boot exit", async () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  const callsBefore = exitSpy.mock.calls.length;
  const p = createPlatform(fakeRenderer());
  const first = p.shutdown("boot-failed");
  const second = p.shutdown("signal:SIGTERM");
  await Promise.all([first, second]);
  const exitCodes = exitSpy.mock.calls.slice(callsBefore).map(([code]) => code);
  expect(exitCodes.length).toBeGreaterThanOrEqual(2);
  expect(exitCodes.every((code) => code === 1)).toBe(true);
  exitSpy.mockRestore();
});

test("createPlatform: over SSH and a non-panic reason, shutdown drains pending stdin before exiting", async () => {
  setEnvironment({ SSH_TTY: "/dev/pts/4" });
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  const p = createPlatform(fakeRenderer());
  const start = Date.now();
  await p.shutdown("user-quit");
  expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  expect(exitSpy).toHaveBeenCalledWith(0);
  exitSpy.mockRestore();
});

test("createPlatform: over SSH, stdin activity during the drain window resets the quiet timer instead of ending it early", async () => {
  setEnvironment({ SSH_TTY: "/dev/pts/4" });
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  const p = createPlatform(fakeRenderer());
  const start = Date.now();
  setTimeout(() => process.stdin.emit("data", Buffer.from("x")), 30);
  await p.shutdown("user-quit");
  expect(Date.now() - start).toBeGreaterThanOrEqual(140);
  expect(exitSpy).toHaveBeenCalledWith(0);
  exitSpy.mockRestore();
});

test("createPlatform: suspend()/resume() swallow renderer errors instead of throwing", async () => {
  const p = createPlatform(fakeRenderer({ throwOnSuspend: true, throwOnResume: true }));
  expect(() => p.suspend()).not.toThrow();
  expect(() => p.resume()).not.toThrow();
});

test("createPlatform: suspend()/resume() delegate to the renderer when it does not throw", async () => {
  const renderer = fakeRenderer();
  const suspendSpy = spyOn(renderer, "suspend");
  const resumeSpy = spyOn(renderer, "resume");
  const p = createPlatform(renderer);
  p.suspend();
  p.resume();
  expect(suspendSpy).toHaveBeenCalledTimes(1);
  expect(resumeSpy).toHaveBeenCalledTimes(1);
});

test("createPlatform: readClipboardImage() delegates to the injectable clipboard runner", async () => {
  const run = clipboardRunner(() => failResult(new Error("ENOENT")));
  const p = createPlatform(fakeRenderer(), { clipboardProcess: run });
  expect(await p.readClipboardImage()).toBeNull();
});

test("nativeClipboardCopy: on win32, copyText invokes the PowerShell clipboard candidate", async () => {
  setPlatform("win32");
  const run = clipboardRunner();
  const p = createPlatform(fakeRenderer(), { clipboardProcess: run });
  expect(await p.copyText("hello")).toBe(true);
  expect(run).toHaveBeenCalledTimes(1);
  const request = run.mock.calls[0]![0];
  expect(typeof request.command).toBe("string");
  expect(Array.isArray(request.args)).toBe(true);
});

test("nativeClipboardCopy: a candidate error is treated as a miss, not a crash", async () => {
  setEnvironment({ DISPLAY: ":0" });
  // Errors surface from runClipboardProcess as result.error; the injectable
  // seam returns that shape rather than throwing through the platform layer.
  const run = clipboardRunner(() => failResult(new Error("spawn EPERM")));
  const p = createPlatform(fakeRenderer({ oscResult: false }), { clipboardProcess: run });
  expect(await p.copyText("hello")).toBe(false);
});

test("readClipboardImage: on win32, the PowerShell image script is attempted", async () => {
  setPlatform("win32");
  const run = clipboardRunner(() => okResult(Buffer.from("")));
  expect(await readClipboardImage(undefined, run)).toBeNull();
  expect(run).toHaveBeenCalledTimes(1);
});

test("readClipboardImage: a candidate error is skipped, not fatal", async () => {
  setEnvironment({ DISPLAY: ":0" });
  const run = clipboardRunner(() => failResult(new Error("spawn EPERM")));
  expect(await readClipboardImage(undefined, run)).toBeNull();
});
