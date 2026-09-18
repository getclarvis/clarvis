import type { Accessor, JSX } from "solid-js";
import type { SettingsAdapter } from "../../adapters/settings.ts";
import type { MemoryMode, MemoryModeStore } from "../../adapters/memory-mode.ts";
import { memoryState } from "../../adapters/execution-safety.ts";
import type { Interaction } from "../../keys/interaction.ts";
import { glyph, glyphColWidth } from "../../theme/glyphs.ts";
import { tokens } from "../../theme/tokens.ts";
import { ListPicker } from "./ListPicker.tsx";

const CURRENT_COL_WIDTH = glyphColWidth("radioOn");
const LABEL_COL_WIDTH = 5;

interface MemoryChoice {
  value: MemoryMode;
  label: string;
  detail: string;
}

const MEMORY_CHOICES: readonly MemoryChoice[] = [
  { value: "on", label: "On", detail: "read before runs and learn afterward" },
  { value: "off", label: "Off", detail: "do not read or update memory" },
];

/** Quick picker for the session-only Memory mode. */
export function MemoryPicker(props: {
  interaction: Interaction;
  settings: SettingsAdapter;
  memory: MemoryModeStore;
  active: Accessor<boolean>;
  notify: (message: string, tone?: "info" | "success" | "warn" | "error") => void;
  onClose: () => void;
  onApplied: () => void;
}): JSX.Element {
  const apply = (mode: MemoryMode): void => {
    props.memory.setMode(mode);
    const effective = memoryState(props.settings.effective(), mode);
    if (mode === "on" && effective === "inert") {
      props.notify(
        `memory: on (this session) ${glyph("emDash")} applies to the next run; memory model not resolved, so memory will not learn ${glyph("emDash")} configure it in Memory settings`,
        "warn",
      );
    } else if (mode === "on" && effective === "off") {
      props.notify(
        `memory remains off ${glyph("emDash")} enable it in Settings > Memory before the next run`,
        "warn",
      );
    } else {
      props.notify(
        `memory: ${mode} (this session) ${glyph("emDash")} applies to the next run`,
        "success",
      );
    }
    props.onApplied();
  };

  return (
    <ListPicker<MemoryChoice>
      keymap={props.interaction.keymap}
      active={props.active}
      resetKey={props.active}
      title="Select memory"
      items={() => [...MEMORY_CHOICES]}
      initialIndex={Math.max(
        0,
        MEMORY_CHOICES.findIndex((choice) => choice.value === props.memory.mode()),
      )}
      idPrefix="memory-"
      confirmLabel="use memory"
      size="sm"
      onConfirm={(choice) => apply(choice.value)}
      onClose={props.onClose}
      cells={(choice, selected) => [
        {
          width: CURRENT_COL_WIDTH,
          fg: choice.value === props.memory.mode() ? tokens.accent : tokens.muted,
          text: choice.value === props.memory.mode() ? glyph("radioOn") : glyph("radioOff"),
        },
        { width: LABEL_COL_WIDTH, fg: selected() ? tokens.fg : tokens.muted, text: choice.label },
        { grow: true, marginLeft: 1, fg: tokens.muted, text: choice.detail },
      ]}
      preview={(choice) => (
        <box flexDirection="column">
          <text fg={choice.value === "off" ? tokens.warn : tokens.fg}>
            {choice.value === "off"
              ? `${glyph("warning")} Memory will not be read or updated in this session.`
              : memoryState(props.settings.effective(), "on") === "inert"
                ? "Memory is enabled, but its model is not resolved, so it cannot learn."
                : memoryState(props.settings.effective(), "on") === "off"
                  ? "Enable Memory in Settings before using it in this session."
                  : "Memory is read before runs and updated afterward."}
          </text>
          <text fg={tokens.muted}>Persisted Memory settings are unchanged.</text>
        </box>
      )}
    />
  );
}
