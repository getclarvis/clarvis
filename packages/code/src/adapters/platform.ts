import { createSignal } from "solid-js";
import type { CliRenderer } from "@opentui/core";
import { depthFromCapabilities, type ColorDepth, type ThemeMode } from "../core/theme-types.ts";
import { resolveShell, shellArgs } from "@clarvis/kernel/local";
import { runClipboardProcess } from "./clipboard-process.ts";
import { detachObserved } from "../core/tasks.ts";
import { diagnosticCount, diagnosticEvent } from "../core/diagnostic-events.ts";
import {
  rendererTeardownSignals,
  type RendererBootstrapOptions,
  type RendererTeardownSignal,
} from "./renderer-bootstrap.ts";
import { openPublicUrl } from "./open-public-url.ts";
export { assertInteractiveTTY, buildRendererConfig } from "./renderer-bootstrap.ts";
export { openPublicUrl } from "./open-public-url.ts";

type ClipboardProcessRunner = typeof runClipboardProcess;

type ShutdownReason =
  `signal:${RendererTeardownSignal}` | "user-quit" | "boot-failed" | "panic" | "tty-lost";

type ShutdownHook = (reason: ShutdownReason) => void | Promise<void>;

/** Live terminal capabilities used by presentation and keyboard policy. */
export interface PlatformCapabilities {
  revision(): number;
  keyboard(): "kitty" | "legacy";
  remote(): boolean;
  runtimePlatform(): "macos" | "windows" | "linux" | "unknown";
  terminal(): { name: string; version?: string };
  mouse(): boolean;
  clipboard: { osc52(): boolean };
  multiplexer(): string;
  plain(): boolean;
  themeBg(): ThemeMode;
  colorDepth(): ColorDepth;
}

/** A clipboard image read back as base64, ready to attach to a message. */
export interface ClipboardImage {
  data: string;
  mediaType: string;
}

/** The platform adapter `code` programs against: capabilities, shutdown, and clipboard I/O. */
export interface Platform {
  capabilities: PlatformCapabilities;
  onShutdown(hook: ShutdownHook): () => void;
  shutdown(reason: ShutdownReason, err?: unknown, exitMessage?: string): Promise<never>;
  suspend(): void;
  resume(): void;
  copyText(text: string): Promise<boolean>;
  /** Open one validated public http(s) URL after an explicit user action. */
  openUrl?(url: string): Promise<boolean>;
  readClipboardImage(): Promise<ClipboardImage | null>;
}

/** Options for {@link createPlatform} / {@link buildRendererConfig}. */
export interface PlatformOptions extends RendererBootstrapOptions {
  /** @internal Injectable process seam for deterministic clipboard tests. */
  clipboardProcess?: ClipboardProcessRunner;
}

/**
 * Read the clipboard through PowerShell, which is where Windows keeps it.
 *
 * @remarks The payload goes in base64 through `-EncodedCommand` for the same
 *   reason every other command does: no character of it is then parsed by the
 *   Windows command-line tokenizer.
 *
 *   The platform is passed explicitly rather than left to `process.platform`,
 *   even though both callers already guard on it. `resolveShell()` with no
 *   arguments memoizes its answer process-wide, so reaching it while the
 *   platform reads `win32` pins PowerShell for every later caller in that
 *   process - `runLocalBash` included, which then tries to spawn the absolute
 *   `powershell.exe` path on a POSIX host and settles every `!` command as a
 *   spawn failure. Production never sees it, because `process.platform` is a
 *   constant there; the suite does, because the clipboard tests pin it to
 *   exercise this very branch. Supplying seams bypasses the cache in both
 *   directions, so this call can neither read a poisoned entry nor write one,
 *   and what it computes on a real Windows host is what the memoized form
 *   returned.
 */
function windowsClipboardArgs(script: string): [string, string[]] {
  const shell = resolveShell({ platform: "win32" });
  return [shell.file, shellArgs(shell, script)];
}

/**
 * @internal Exported only for tests: the PowerShell script that reads piped
 * stdin and writes it to the clipboard.
 * @remarks The shared shell preamble sets `[Console]::OutputEncoding` for what
 *   PowerShell writes; reading piped stdin is governed by `InputEncoding`
 *   instead. Left unset it defaults to the OEM/ANSI codepage and non-ASCII
 *   text arrives on the clipboard as mojibake, so it must be set - and read -
 *   before `ReadToEnd` runs.
 */
export const WINDOWS_CLIPBOARD_COPY_SCRIPT =
  "[Console]::InputEncoding=New-Object System.Text.UTF8Encoding $false;" +
  "Set-Clipboard -Value ([Console]::In.ReadToEnd())";

async function nativeClipboardCopy(
  text: string,
  signal?: AbortSignal,
  run: ClipboardProcessRunner = runClipboardProcess,
): Promise<boolean> {
  const candidates: [string, string[]][] = [];
  if (process.platform === "darwin") candidates.push(["pbcopy", []]);
  if (process.platform === "win32") {
    candidates.push(windowsClipboardArgs(WINDOWS_CLIPBOARD_COPY_SCRIPT));
  }
  if (process.env.WAYLAND_DISPLAY) candidates.push(["wl-copy", []]);
  if (process.env.DISPLAY) {
    candidates.push(["xclip", ["-selection", "clipboard"]]);
    candidates.push(["xsel", ["--clipboard", "--input"]]);
  }
  for (const [cmd, args] of candidates) {
    const result = await run({ command: cmd, args, stdin: text, signal });
    if (result.cancelled) return false;
    if (result.error === undefined && !result.timedOut && result.exitCode === 0) return true;
  }
  return false;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * Read a PNG image off the system clipboard, trying each platform-appropriate
 * clipboard tool in turn.
 *
 * @returns the image as base64, or `null` if no tool succeeded or the clipboard
 *   did not hold a PNG.
 */
export async function readClipboardImage(
  signal?: AbortSignal,
  run: ClipboardProcessRunner = runClipboardProcess,
): Promise<ClipboardImage | null> {
  const candidates: [string, string[]][] = [];
  if (process.platform === "darwin") candidates.push(["pngpaste", []]);
  if (process.platform === "win32") {
    candidates.push(
      windowsClipboardArgs(
        "Add-Type -AssemblyName System.Windows.Forms;" +
          "$img=[Windows.Forms.Clipboard]::GetImage();" +
          "if($img){$ms=New-Object IO.MemoryStream;" +
          "$img.Save($ms,[Drawing.Imaging.ImageFormat]::Png);" +
          "[Console]::OpenStandardOutput().Write($ms.ToArray(),0,$ms.Length)}",
      ),
    );
  }
  if (process.env.WAYLAND_DISPLAY) candidates.push(["wl-paste", ["--type", "image/png"]]);
  if (process.env.DISPLAY)
    candidates.push(["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]]);
  for (const [cmd, args] of candidates) {
    const result = await run({ command: cmd, args, signal });
    if (result.cancelled) return null;
    if (
      result.error !== undefined ||
      result.timedOut ||
      result.outputExceeded ||
      result.exitCode !== 0 ||
      result.stdout.length === 0
    )
      continue;
    if (!isPng(result.stdout)) continue;
    return { data: result.stdout.toString("base64"), mediaType: "image/png" };
  }
  return null;
}

/**
 * Total wall budget for the shutdown sequence before the process exits anyway.
 *
 * @remarks Bounds work whose failure is not fatal — flushing the session,
 * releasing leases, closing transports — so the only question is how long a user
 * who pressed quit waits for a tidy exit. Two seconds is past the disk writes
 * involved and inside what reads as an immediate exit; beyond it the terminal
 * appears hung, and the same cleanup happens on the next start anyway.
 */
const SHUTDOWN_BUDGET_MS = 2000;
const DRAIN_MAX_MS = 500;
const DRAIN_QUIET_MS = 120;

/**
 * Wait for stdin to go `quietMs` without data, capped at `maxMs` total — used
 * on shutdown over a remote (SSH) session to swallow input that arrives after
 * the terminal has already been torn down.
 */
function drainStdinUntilQuiet(maxMs: number, quietMs: number): Promise<void> {
  const stdin = process.stdin;
  if (!stdin || typeof stdin.on !== "function") return Promise.resolve();
  return new Promise<void>((resolve) => {
    let quiet: ReturnType<typeof setTimeout>;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(quiet);
      clearTimeout(cap);
      stdin.off("data", onData);
      resolve();
    };
    const onData = (): void => {
      clearTimeout(quiet);
      quiet = setTimeout(finish, quietMs);
    };
    stdin.on("data", onData);
    quiet = setTimeout(finish, quietMs);
    const cap = setTimeout(finish, maxMs);
  });
}

/**
 * Build the {@link Platform} adapter around an OpenTUI renderer: capability
 * flags, graceful shutdown, and clipboard I/O.
 *
 * @param renderer - the active OpenTUI renderer.
 * @param _opts - platform options (currently unused).
 * @returns the {@link Platform} the rest of `code` programs against.
 * @remarks The signal set matches the catchable OpenTUI defaults for the current
 *   platform. `SIGKILL` remains inherently uncatchable.
 */
export function createPlatform(renderer: CliRenderer, opts: PlatformOptions = {}): Platform {
  const hooks = new Set<ShutdownHook>();
  const clipboardControllers = new Set<AbortController>();
  let restored = false;
  let shuttingDown = false;
  let shutdownFailed = false;

  const [themeBg, setThemeBg] = createSignal<ThemeMode>(renderer.themeMode ?? "dark");
  const [capabilityRevision, setCapabilityRevision] = createSignal(0);
  diagnosticEvent("platform.create", {
    dev: opts.dev === true,
    remote: !!(process.env.SSH_TTY ?? process.env.SSH_CONNECTION),
    runtime: process.platform,
  });
  renderer.on("theme_mode", (mode: ThemeMode) => {
    diagnosticCount("renderer.theme-mode", { mode });
    setThemeBg(mode);
  });
  renderer.on("capabilities", () => {
    diagnosticCount("renderer.capabilities");
    setCapabilityRevision((value) => value + 1);
  });
  detachObserved("terminal_theme_detection", () =>
    renderer.waitForThemeMode?.().then((mode) => {
      if (mode) setThemeBg(mode);
    }),
  );

  const capabilities: PlatformCapabilities = {
    revision: capabilityRevision,
    keyboard: () => (renderer.capabilities?.kitty_keyboard ? "kitty" : "legacy"),
    remote: () =>
      renderer.capabilities?.remote ?? !!(process.env.SSH_TTY ?? process.env.SSH_CONNECTION),
    runtimePlatform: () =>
      process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
          ? "windows"
          : process.platform === "linux"
            ? "linux"
            : "unknown",
    terminal: () => ({
      name: renderer.capabilities?.terminal?.name || process.env.TERM || "unknown",
      ...(renderer.capabilities?.terminal?.version
        ? { version: renderer.capabilities.terminal.version }
        : {}),
    }),
    mouse: () => renderer.useMouse === true,
    clipboard: { osc52: () => renderer.capabilities?.osc52 === true },
    multiplexer: () => renderer.capabilities?.multiplexer ?? "none",
    plain: () => !process.stdout.isTTY,
    themeBg: () => themeBg(),
    colorDepth: () => {
      const caps = renderer.capabilities;
      return depthFromCapabilities(!caps || !!caps.rgb, !!caps?.ansi256, !!process.env.NO_COLOR);
    },
  };

  function restore(): void {
    if (restored) return;
    restored = true;
    diagnosticEvent("renderer.destroy");
    try {
      renderer.destroy();
    } catch {}
  }

  async function shutdown(
    reason: ShutdownReason,
    err?: unknown,
    exitMessage?: string,
  ): Promise<never> {
    const failed = reason === "panic" || reason === "boot-failed";
    shutdownFailed ||= failed;
    if (shuttingDown) {
      restore();
      process.exit(shutdownFailed ? 1 : 0);
    }
    shuttingDown = true;
    diagnosticEvent(
      "platform.shutdown.begin",
      { reason, ...(err === undefined ? {} : { error: err }) },
      failed ? "error" : "info",
    );
    for (const controller of clipboardControllers) controller.abort("platform shutdown");

    const run = Promise.allSettled(
      [...hooks].reverse().map((h) => Promise.resolve().then(() => h(reason))),
    );
    const budget = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_BUDGET_MS));
    await Promise.race([run, budget]);
    diagnosticEvent("platform.shutdown.hooks-settled", { reason });

    const remote = !!(process.env.SSH_TTY ?? process.env.SSH_CONNECTION);
    restore();
    if (reason !== "panic" && remote) await drainStdinUntilQuiet(DRAIN_MAX_MS, DRAIN_QUIET_MS);
    if (reason === "panic" && err)
      process.stderr.write(String((err as Error)?.stack ?? err) + "\n");
    if (exitMessage !== undefined) process.stdout.write(exitMessage + "\n");
    process.exit(shutdownFailed ? 1 : 0);
  }

  process.on("exit", restore);
  process.on("uncaughtException", (e) => void shutdown("panic", e));
  process.on("unhandledRejection", (e) => void shutdown("panic", e));
  for (const signal of rendererTeardownSignals(process.platform)) {
    process.on(signal, () => void shutdown(`signal:${signal}`));
  }

  return {
    capabilities,
    onShutdown(hook: ShutdownHook): () => void {
      hooks.add(hook);
      return () => hooks.delete(hook);
    },
    shutdown,
    suspend(): void {
      try {
        renderer.suspend();
      } catch {}
    },
    resume(): void {
      try {
        renderer.resume();
      } catch {}
    },
    async copyText(text: string): Promise<boolean> {
      const controller = new AbortController();
      clipboardControllers.add(controller);
      const remote = !!(process.env.SSH_TTY ?? process.env.SSH_CONNECTION);
      const osc = (): boolean => {
        try {
          return renderer.copyToClipboardOSC52(text);
        } catch {
          return false;
        }
      };
      try {
        if (remote && osc()) return true;
        if (await nativeClipboardCopy(text, controller.signal, opts.clipboardProcess)) return true;
        return remote ? false : osc();
      } finally {
        clipboardControllers.delete(controller);
      }
    },
    openUrl: openPublicUrl,
    async readClipboardImage(): Promise<ClipboardImage | null> {
      const controller = new AbortController();
      clipboardControllers.add(controller);
      try {
        return await readClipboardImage(controller.signal, opts.clipboardProcess);
      } finally {
        clipboardControllers.delete(controller);
      }
    },
  };
}
