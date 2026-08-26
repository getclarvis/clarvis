import { Show, type Accessor, type JSX } from "solid-js";
import type { MemoryPressureSnapshot } from "../adapters/memory-pressure.ts";
import { tokens } from "../theme/tokens.ts";
import { glyph } from "../theme/glyphs.ts";

function gib(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

/** Persistent warning/recovery surface for the interactive TUI's RSS fuse. */
export function MemoryPressureBanner(props: {
  state: Accessor<MemoryPressureSnapshot>;
  onRecover: () => void;
}): JSX.Element {
  const visible = (): boolean =>
    props.state().advisory || !["armed", "disabled"].includes(props.state().phase);
  const blocked = (): boolean =>
    ["aborting", "tripped", "recovering", "cooling"].includes(props.state().phase);
  const detail = (): string => {
    switch (props.state().phase) {
      case "warning":
        return "High memory use; finish or cancel expensive work if it keeps rising.";
      case "aborting":
        return "Memory limit reached; aborting active work while the TUI stays alive.";
      case "tripped":
        return "Work is blocked. Recover memory to rebuild the backend.";
      case "recovering":
        return "Rebuilding the backend and releasing runtime resources.";
      case "cooling":
        return "Backend rebuilt; waiting for three safe RSS samples. /clear can clear the transcript.";
      default:
        return props.state().advisory
          ? "Memory is rising steadily above the healthy baseline; inspect /debug before it reaches the fuse."
          : "";
    }
  };
  return (
    <Show when={visible()}>
      <box
        flexDirection="column"
        flexShrink={0}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        paddingBottom={1}
        backgroundColor={tokens.bgElev}
      >
        <text fg={blocked() ? tokens.del : tokens.warn} wrapMode="word">
          {`${glyph(blocked() ? "error" : "warning")} Memory ${gib(props.state().rss)} / ${gib(props.state().limitBytes)} ${glyph("separator")} ${detail()}`}
        </text>
        <Show when={props.state().phase === "tripped"}>
          <text fg={tokens.accent} onMouseDown={props.onRecover}>
            {"Recover memory  (/recover-memory)"}
          </text>
        </Show>
      </box>
    </Show>
  );
}
