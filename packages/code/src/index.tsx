import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { createSignal, Show, type JSX } from "solid-js";
import {
  helpText,
  parseMode,
  resolveDebugRequest,
  productVersion,
  usageText,
  versionText,
  type Mode,
} from "./cli-args.ts";
import { applyAsciiMode } from "./theme/glyphs.ts";
import { createStartupComposerState, StartupComposer } from "./views/StartupComposer.tsx";
import {
  assertInteractiveTTY,
  buildRendererConfig,
  installBootRendererLifecycle,
} from "./adapters/renderer-bootstrap.ts";
import { installTerminalGuard } from "./adapters/terminal-guard.ts";
import type { BootShell } from "./boot-shell.ts";
import type {
  PreparedInteractiveMode,
  prepareInteractiveMode,
  runInteractiveMode,
} from "./runtime.tsx";

type InteractiveMode = Extract<Mode, { kind: "run" | "resume" | "continue" }>;
type InteractiveRuntime = {
  prepareInteractiveMode: typeof prepareInteractiveMode;
  runInteractiveMode: typeof runInteractiveMode;
};

async function runInteractive(mode: InteractiveMode): Promise<void> {
  assertInteractiveTTY();
  applyAsciiMode(mode.ascii);
  let runtime: InteractiveRuntime | undefined;
  let preparedMode: PreparedInteractiveMode | undefined;
  if (mode.kind === "resume" || mode.kind === "continue") {
    runtime = await import("./runtime.tsx");
    preparedMode = await runtime.prepareInteractiveMode(mode);
  }
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION)
    process.env.OPENTUI_FORCE_EXPLICIT_WIDTH ??= "true";
  const dev = !!process.env.CLARVIS_CODE_DEV;
  const renderer = await createCliRenderer(buildRendererConfig({ dev }));
  const rendererLifecycle = installBootRendererLifecycle(renderer);
  const releaseTerminal = installTerminalGuard();
  process.once("exit", releaseTerminal);
  const startupInput = createStartupComposerState();
  const [view, setView] = createSignal<(() => JSX.Element) | undefined>(undefined);
  const Root = (): JSX.Element => (
    <Show
      when={view()}
      keyed
      fallback={
        <StartupComposer
          state={startupInput}
          acceptsInput={mode.kind === "run"}
          version={productVersion()}
        />
      }
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
      handoffRendererLifecycle: (shutdown) => rendererLifecycle.handoff(shutdown),
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
    runtime ??= await import("./runtime.tsx");
    await runtime.runInteractiveMode(mode, shell, preparedFoundation, preparedMode);
  } catch (error) {
    rendererLifecycle.destroy();
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
