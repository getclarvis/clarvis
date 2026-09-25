import { createSignal, type Accessor, type JSX } from "solid-js";
import type { SettingsAdapter } from "../../adapters/settings.ts";
import {
  saveMemoryMode,
  type MemoryMode,
  type MemoryModeStore,
} from "../../adapters/memory-mode.ts";
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

/** Quick picker for the global Memory choice. */
export function MemoryPicker(props: {
  interaction: Interaction;
  settings: SettingsAdapter;
  runModel: string;
  memory: MemoryModeStore;
  active: Accessor<boolean>;
  notify: (message: string, tone?: "info" | "success" | "warn" | "error") => void;
  onClose: () => void;
  onApplied: () => void;
}): JSX.Element {
  const [saving, setSaving] = createSignal(false);
  const apply = async (mode: MemoryMode): Promise<void> => {
    if (saving()) return;
    setSaving(true);
    try {
      await saveMemoryMode(props.settings, props.memory, mode);
      const effective = memoryState(props.settings.effective(), mode, props.runModel);
      if (mode === "on" && effective === "inert") {
        props.notify(
          `memory: on ${glyph("emDash")} saved globally; the run model is unavailable, so memory will not learn`,
          "warn",
        );
      } else {
        props.notify(`memory: ${mode} ${glyph("emDash")} saved globally`, "success");
      }
      props.onApplied();
    } catch {
      props.notify("Could not save the global Memory choice", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ListPicker<MemoryChoice>
      keymap={props.interaction.keymap}
      active={props.active}
      locked={saving}
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
      onConfirm={(choice) => void apply(choice.value)}
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
              ? `${glyph("warning")} Memory will not be read or updated.`
              : memoryState(props.settings.effective(), "on", props.runModel) === "inert"
                ? "The run model is unavailable, so memory cannot learn."
                : "Memory is read before runs and updated afterward."}
          </text>
        </box>
      )}
    />
  );
}
