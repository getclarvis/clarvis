import type { Accessor, JSX } from "solid-js";
import { Show } from "solid-js";
import type { ViewHost } from "../../keys/commands.ts";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { bindLevelKeys, ViewFrame } from "../config/view-host.tsx";

/** Visible phase of the first-run Clarvis setup. */
export type SetupPhase = "welcome" | "preparing" | "ready" | "error";

/** Reactive setup copy rendered by {@link SetupView}. */
export interface SetupState {
  phase: SetupPhase;
  detail: string;
  model?: string;
  agent?: string;
}

/** Branded, decision-first shell around provider setup and automatic fleet preparation. */
export function SetupView(
  host: ViewHost,
  deps: {
    state: Accessor<SetupState>;
    begin(): void;
    retry(): void;
    finish(): void;
  },
): JSX.Element {
  const primary = (): { label: string; run: () => void } | undefined => {
    switch (deps.state().phase) {
      case "welcome":
        return { label: "begin setup", run: () => deps.begin() };
      case "ready":
        return { label: "start using Clarvis", run: () => deps.finish() };
      case "error":
        return { label: "retry", run: () => deps.retry() };
      case "preparing":
        return undefined;
    }
  };
  const spec = (): LevelSpec => ({
    verbs: [
      ...(primary()
        ? [
            {
              id: "setup.primary",
              key: "return",
              label: primary()!.label,
              run: primary()!.run,
              category: "primary",
              hintGroup: "primary" as const,
              hintPriority: 100,
              essential: true,
            },
          ]
        : []),
    ],
  });
  bindLevelKeys({
    host,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  return (
    <ViewFrame
      host={host}
      title={deps.state().phase === "ready" ? "Clarvis is ready" : "Set up Clarvis"}
      purpose="A short setup for your model and agent fleet"
      actionFilter={(action) => action.id !== "run.cancel"}
    >
      <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <box flexDirection="column" alignItems="center">
          <Show when={deps.state().phase === "welcome"}>
            <text fg={tokens.accent}>Step 0 of 2</text>
            <text fg={tokens.fg}>Connect a provider and choose a model.</text>
            <text fg={tokens.muted}>
              About 2 minutes · Clarvis saves the provider and model before Ready.
            </text>
            <text fg={tokens.muted}>
              Recommended choices come first; the full catalog stays searchable.
            </text>
          </Show>
          <Show when={deps.state().phase === "preparing"}>
            <text fg={tokens.accent}>{glyph("pending") + " Preparing Clarvis"}</text>
            <text fg={tokens.muted}>{deps.state().detail}</text>
          </Show>
          <Show when={deps.state().phase === "error"}>
            <text fg={tokens.del}>{glyph("error") + " Setup needs another try"}</text>
            <text fg={tokens.muted}>{deps.state().detail}</text>
          </Show>
          <Show when={deps.state().phase === "ready"}>
            <text fg={tokens.add}>{glyph("success") + " Ready to use"}</text>
            <text fg={tokens.fg}>{`Agent   ${deps.state().agent ?? "coder"}`}</text>
            <text fg={tokens.fg}>{`Model   ${deps.state().model ?? "configured default"}`}</text>
            <text fg={tokens.muted}>Command review, memory and planning use Clarvis defaults.</text>
          </Show>
        </box>
      </box>
    </ViewFrame>
  );
}
