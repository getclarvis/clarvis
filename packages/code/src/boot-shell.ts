import type { CliRenderer } from "@opentui/core";
import type { JSX } from "solid-js";
import type { StartupComposerSnapshot } from "./views/StartupComposer.tsx";

/** The already-painted renderer handed from the lightweight entrypoint to the application runtime. */
export interface BootShell {
  readonly renderer: CliRenderer;
  readonly shellElapsedMs: number;
  releaseTerminal(): void;
  takeStartupInput(): StartupComposerSnapshot;
  mount(view: () => JSX.Element): Promise<void>;
}
