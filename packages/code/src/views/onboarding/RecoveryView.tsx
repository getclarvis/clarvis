import type { Accessor, JSX } from "solid-js";
import { createEffect } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { ViewHost } from "../../keys/commands.ts";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { bindLevelKeys, ViewFrame } from "../config/view-host.tsx";
import { BrandBanner } from "../Splash.tsx";

/** One blocking startup condition presented by the guided recovery screen. */
export interface StartupIssue {
  label: string;
  detail: string;
  hint?: string;
}

/** Branded startup repair page that presents one blocker and one primary action. */
export function RecoveryView(
  host: ViewHost,
  deps: {
    issue: Accessor<StartupIssue | undefined>;
    resolve(): void;
    openDoctor(): void;
    ready(): boolean;
    onReady(): void;
  },
): JSX.Element {
  const dims = useTerminalDimensions();
  createEffect(() => {
    if (deps.ready()) queueMicrotask(() => deps.onReady());
  });
  const spec = (): LevelSpec => ({
    verbs: [
      {
        id: "recovery.resolve",
        key: "return",
        label: "repair",
        run: () => deps.resolve(),
        category: "primary",
        hintGroup: "primary",
        hintPriority: 100,
        essential: true,
      },
      { key: "d", label: "open Doctor", run: () => deps.openDoctor(), category: "navigation" },
    ],
  });
  bindLevelKeys({
    host,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  return (
    <ViewFrame host={host} title="Repair Clarvis" purpose="Resolve the first startup blocker">
      <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <BrandBanner width={() => dims().width} />
        <box flexDirection="column" paddingTop={2} maxWidth={76}>
          <text fg={tokens.warn}>{glyph("warning") + " Clarvis cannot start a run yet"}</text>
          <text
            fg={tokens.fg}
          >{`${deps.issue()?.label ?? "configuration"}: ${deps.issue()?.detail ?? "rechecking"}`}</text>
          <text fg={tokens.muted}>
            {deps.issue()?.hint ?? "Open the focused repair and return here."}
          </text>
        </box>
      </box>
    </ViewFrame>
  );
}
