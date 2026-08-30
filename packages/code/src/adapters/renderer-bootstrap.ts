import { constants } from "node:os";
import type { CliRenderer, CliRendererConfig, KeyEvent } from "@opentui/core";
import { diagnosticCount } from "../core/diagnostic-events.ts";

/** Options that affect the renderer before the application runtime is loaded. */
export interface RendererBootstrapOptions {
  dev?: boolean;
  /** @internal Injectable runtime seam for renderer-policy tests. */
  runtimePlatform?: NodeJS.Platform;
  /** @internal Injectable environment seam for renderer-policy tests. */
  processEnv?: NodeJS.ProcessEnv;
}

/** Catchable signals OpenTUI owns by default when a host does not replace them. */
export type RendererTeardownSignal =
  "SIGINT" | "SIGTERM" | "SIGQUIT" | "SIGABRT" | "SIGHUP" | "SIGPIPE" | "SIGBREAK" | "SIGBUS";

/** Platform-supported catchable signals that must restore the renderer before exit. */
export function rendererTeardownSignals(
  platform: NodeJS.Platform,
): readonly RendererTeardownSignal[] {
  return platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT", "SIGHUP", "SIGPIPE", "SIGBUS"];
}

function signalExitCode(signal: RendererTeardownSignal): number {
  return 128 + (constants.signals[signal] ?? 1);
}

/** Process surface used by the renderer's pre-platform lifecycle owner. */
export type BootRendererProcess = Pick<NodeJS.Process, "platform" | "once" | "off" | "exit">;

/** Ownership transfer from the lightweight shell to the complete platform. */
export interface BootRendererLifecycle {
  /**
   * Transfer process-signal ownership and retain raw Ctrl+C until the full keymap is mounted.
   *
   * @param shutdown - Complete-platform shutdown for a raw Ctrl+C during hydration.
   * @returns A release for the temporary key and exit listeners.
   */
  handoff(shutdown: () => unknown): () => void;
  /** Restore the renderer immediately when boot fails before ownership transfers. */
  destroy(): void;
}

/**
 * Own renderer teardown from the instant raw mode and the alternate screen exist.
 *
 * @param renderer - The newly created renderer, before any runtime import or preflight.
 * @param host - Injectable process event surface for deterministic lifecycle tests.
 * @returns The two-phase lifecycle owner transferred to {@link createPlatform} by the boot shell.
 */
export function installBootRendererLifecycle(
  renderer: CliRenderer,
  host: BootRendererProcess = process,
): BootRendererLifecycle {
  const signals = rendererTeardownSignals(host.platform);
  let phase: "boot" | "platform" | "released" | "destroyed" = "boot";
  let platformShutdown: (() => unknown) | undefined;
  const signalHandlers = new Map<RendererTeardownSignal, () => void>();

  const removeSignals = (): void => {
    for (const [signal, handler] of signalHandlers) host.off(signal, handler);
    signalHandlers.clear();
  };
  const removeKey = (): void => {
    renderer.keyInput.off("keypress", onKey);
  };
  const restore = (): void => {
    if (phase === "destroyed") return;
    phase = "destroyed";
    removeSignals();
    removeKey();
    host.off("exit", onExit);
    try {
      renderer.destroy();
    } catch {}
  };
  const onExit = (): void => restore();
  const exitForSignal = (exitCode: number): void => {
    restore();
    host.exit(exitCode);
  };
  const onKey = (key: KeyEvent): void => {
    if (key.defaultPrevented || !key.ctrl || key.name !== "c") return;
    key.preventDefault();
    key.stopPropagation();
    if (phase === "platform") {
      void platformShutdown?.();
      return;
    }
    if (phase === "boot") exitForSignal(130);
  };

  host.once("exit", onExit);
  for (const signal of signals) {
    const handler = (): void => exitForSignal(signalExitCode(signal));
    signalHandlers.set(signal, handler);
    host.once(signal, handler);
  }
  renderer.keyInput.on("keypress", onKey);

  return {
    handoff(shutdown) {
      if (phase !== "boot") return () => undefined;
      phase = "platform";
      platformShutdown = shutdown;
      removeSignals();
      return (): void => {
        if (phase !== "platform") return;
        phase = "released";
        platformShutdown = undefined;
        removeKey();
        host.off("exit", onExit);
      };
    },
    destroy: restore,
  };
}

/**
 * Exit with guidance when an interactive launch has no terminal on either stream.
 *
 * @param io - Optional streams for deterministic tests.
 */
export function assertInteractiveTTY(io?: {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}): void {
  const stdin = io?.stdin ?? process.stdin;
  const stdout = io?.stdout ?? process.stdout;
  if (!stdout.isTTY || !stdin.isTTY) {
    process.stderr.write(
      "clarvis is an interactive TUI and needs a terminal.\n" +
        "Headless modes: clarvis --help | --list | --delete <id> | --refresh-models | --update | -p <prompt>\n",
    );
    process.exit(2);
  }
}

const ITERM_MODIFIER_STATE_REPORT = /^\[[1-8](?::[123])?u$/;

function consumeItermModifierStateReport(sequence: string): boolean {
  const consumed =
    sequence.charCodeAt(0) === 0x1b && ITERM_MODIFIER_STATE_REPORT.test(sequence.slice(1));
  if (consumed) diagnosticCount("keyboard.event.iterm-modifier-state", { outcome: "discarded" });
  return consumed;
}

function useFullItermKeyboardReporting(opts: RendererBootstrapOptions): boolean {
  const runtimePlatform = opts.runtimePlatform ?? process.platform;
  const env = opts.processEnv ?? process.env;
  return (
    runtimePlatform === "darwin" &&
    env.TERM_PROGRAM === "iTerm.app" &&
    env.TMUX === undefined &&
    env.SSH_TTY === undefined &&
    env.SSH_CONNECTION === undefined
  );
}

/** Return the fixed OpenTUI renderer policy used by the lightweight boot shell. */
export function buildRendererConfig(opts: RendererBootstrapOptions = {}): CliRendererConfig {
  const fullItermKeyboard = useFullItermKeyboardReporting(opts);
  return {
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    exitSignals: [],
    useKittyKeyboard: fullItermKeyboard ? { allKeysAsEscapes: true, reportText: true } : {},
    ...(fullItermKeyboard ? { prependInputHandlers: [consumeItermModifierStateReport] } : {}),
    useMouse: true,
    autoFocus: true,
    clearOnShutdown: true,
    consoleMode: opts.dev === true ? "console-overlay" : "disabled",
    openConsoleOnError: opts.dev ?? false,
    targetFps: 30,
    maxFps: 60,
  };
}
