import type { CliRendererConfig } from "@opentui/core";
import { diagnosticCount } from "../core/diagnostic-events.ts";

/** Options that affect the renderer before the application runtime is loaded. */
export interface RendererBootstrapOptions {
  dev?: boolean;
  /** @internal Injectable runtime seam for renderer-policy tests. */
  runtimePlatform?: NodeJS.Platform;
  /** @internal Injectable environment seam for renderer-policy tests. */
  processEnv?: NodeJS.ProcessEnv;
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
