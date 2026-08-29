import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { createSignal, Show, type JSX } from "solid-js";
import {
  helpText,
  parseMode,
  resolveDebugRequest,
  usageText,
  versionText,
  type Mode,
} from "./cli-args.ts";
import { applyAsciiMode } from "./theme/glyphs.ts";
import { createStartupComposerState, StartupComposer } from "./views/StartupComposer.tsx";
import { assertInteractiveTTY, buildRendererConfig } from "./adapters/renderer-bootstrap.ts";
import { installTerminalGuard } from "./adapters/terminal-guard.ts";
import type { BootShell } from "./boot-shell.ts";

type InteractiveMode = Extract<Mode, { kind: "run" | "resume" | "continue" }>;

async function runInteractive(mode: InteractiveMode): Promise<void> {
  assertInteractiveTTY();
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION)
    process.env.OPENTUI_FORCE_EXPLICIT_WIDTH ??= "true";
  applyAsciiMode(mode.ascii);
  const dev = !!process.env.CLARVIS_CODE_DEV;
  const renderer = await createCliRenderer(buildRendererConfig({ dev }));
  const releaseTerminal = installTerminalGuard();
  process.once("exit", releaseTerminal);
  const startupInput = createStartupComposerState();
  const [view, setView] = createSignal<(() => JSX.Element) | undefined>(undefined);
  const Root = (): JSX.Element => (
    <Show
      when={view()}
      keyed
      fallback={<StartupComposer state={startupInput} acceptsInput={mode.kind === "run"} />}
    >
      {(View: () => JSX.Element) => <View />}
    </Show>
  );
  try {
    await render(Root, renderer);
    await renderer.idle();
    const shell: BootShell = {
      renderer,
      shellElapsedMs: Math.round(process.uptime() * 1000),
      releaseTerminal,
      takeStartupInput: () => startupInput.take(),
      async mount(nextView): Promise<void> {
        setView(() => nextView);
        await renderer.idle();
      },
    };
    process.env.CLARVIS_AGENT_TOOLS_MAX_GRANT ??= "exec";
    const preparedFoundation =
      mode.kind === "run" &&
      mode.worktree === undefined &&
      !resolveDebugRequest(mode, process.env).enabled
        ? import("./startup-foundation.ts").then((module) => module.prepareStartupFoundation(mode))
        : undefined;
    preparedFoundation?.catch(() => undefined);
    const runtime = await import("./runtime.tsx");
    await runtime.runInteractiveMode(mode, shell, preparedFoundation);
  } catch (error) {
    try {
      renderer.destroy();
    } catch {}
    releaseTerminal();
    throw error;
  }
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  switch (mode.kind) {
    case "usage-error":
      process.stderr.write(`${mode.message}\n${usageText()}\n`);
      return void process.exit(1);
    case "help":
      process.stdout.write(helpText() + "\n");
      return void process.exit(0);
    case "version":
      process.stdout.write(versionText() + "\n");
      return void process.exit(0);
    case "update": {
      const { productVersion } = await import("./cli-args.ts");
      const { runUpdateCommand } = await import("./update/index.ts");
      return void process.exit(await runUpdateCommand({ currentVersion: productVersion() }));
    }
    case "run":
    case "resume":
    case "continue":
      return void (await runInteractive(mode));
    default: {
      const runtime = await import("./runtime.tsx");
      return void (await runtime.runHeadlessMode(mode));
    }
  }
}

void main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`clarvis failed: ${detail}\n`);
  process.exitCode = 1;
});
