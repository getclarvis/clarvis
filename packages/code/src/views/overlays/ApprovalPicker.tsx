import { createSignal, type Accessor, type JSX } from "solid-js";
import type { SettingsAdapter } from "../../adapters/settings.ts";
import type { Interaction } from "../../keys/interaction.ts";
import { ListPicker } from "./ListPicker.tsx";
import { glyph, glyphColWidth } from "../../theme/glyphs.ts";
import { tokens } from "../../theme/tokens.ts";

type Mode = "manual" | "auto";
const MODES: { value: Mode; label: string; detail: string }[] = [
  { value: "manual", label: "Manual", detail: "You decide eligible approval requests" },
  {
    value: "auto",
    label: "Auto",
    detail: "Judge evaluates eligible approval requests",
  },
];

/** Persist the global decision route for subsequent runs. */
export function ApprovalPicker(props: {
  interaction: Interaction;
  settings: SettingsAdapter;
  active: Accessor<boolean>;
  notify: (message: string, tone?: "info" | "success" | "warn" | "error") => void;
  onClose: () => void;
}): JSX.Element {
  const [saving, setSaving] = createSignal(false);
  const current = (): Mode => {
    props.settings.version();
    return props.settings.read("global")?.approval_mode ?? "manual";
  };
  const modes = () => {
    props.settings.version();
    return props.settings.read("global")?.execution_requirements?.judge_required
      ? MODES.map((mode) =>
          mode.value === "manual"
            ? { ...mode, detail: "Host requires judge for eligible requests" }
            : mode,
        )
      : props.settings.read("global")?.approval_policy === "untrusted"
        ? MODES.map((mode) =>
            mode.value === "auto"
              ? { ...mode, detail: "Untrusted policy routes requests to you" }
              : mode,
          )
        : MODES;
  };
  const autoReady = (): boolean => {
    const settings = props.settings.effective();
    const reference = settings.judge?.model ?? settings.default_model;
    if (!reference) return false;
    return props.settings.validateProviders({ ...settings, default_model: reference }).ok;
  };
  return (
    <ListPicker
      keymap={props.interaction.keymap}
      active={props.active}
      locked={saving}
      title="Approval mode"
      items={modes}
      initialIndex={current() === "auto" ? 1 : 0}
      resetKey={() => `${String(props.active())}:${current()}`}
      idPrefix="approval-mode-"
      confirmLabel="use"
      size="lg"
      onClose={props.onClose}
      onConfirm={(item) => {
        if (saving()) return;
        if (item.value === "auto" && !autoReady()) {
          props.notify(
            "Configure an available judge model and provider before selecting Auto",
            "error",
          );
          return;
        }
        setSaving(true);
        void props.settings
          .write("global", { approval_mode: item.value })
          .then(() => {
            props.notify(`Approval mode: ${item.label}`, "success");
            props.onClose();
          })
          .catch(() => props.notify("Could not save approval mode", "error"))
          .finally(() => setSaving(false));
      }}
      cells={(item, selected) => [
        {
          width: glyphColWidth("radioOn"),
          fg: item.value === current() ? tokens.accent : tokens.muted,
          text: item.value === current() ? glyph("radioOn") : glyph("radioOff"),
        },
        { width: 13, fg: selected() ? tokens.fg : tokens.muted, text: item.label },
        { grow: true, marginLeft: 1, fg: tokens.muted, text: item.detail },
      ]}
    />
  );
}
