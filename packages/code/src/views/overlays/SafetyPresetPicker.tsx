import type { Accessor, JSX } from "solid-js";
import { For, Show } from "solid-js";
import type { Scope } from "@clarvis/protocol";
import type { SettingsAdapter } from "../../adapters/settings.ts";
import type { GuardModeStore } from "../../adapters/guard-mode.ts";
import { deriveSafetyPreset, type CanonicalSafetyPreset } from "../../adapters/execution-safety.ts";
import {
  applySafetyPreset,
  safetyPresetConfirmation,
  SAFETY_PRESET_CHOICES,
  type SafetyPresetChoice,
  type SafetyPresetConfirmation,
} from "../../features/run/safety-presets.ts";
import type { Interaction } from "../../keys/interaction.ts";
import { errorText } from "../../adapters/errors.ts";
import { detachObserved } from "../../core/tasks.ts";
import { glyph, glyphColWidth } from "../../theme/glyphs.ts";
import { tokens } from "../../theme/tokens.ts";
import { useArmedConfirm } from "../confirm.ts";
import { ListPicker } from "./ListPicker.tsx";

const CURRENT_COL_WIDTH = glyphColWidth("radioOn");
const LABEL_COL_WIDTH = 11;

interface PendingPreset {
  preset: CanonicalSafetyPreset;
  confirmation: SafetyPresetConfirmation;
}

/** Quick picker for the canonical sandbox and command-review combinations. */
export function SafetyPresetPicker(props: {
  interaction: Interaction;
  settings: SettingsAdapter;
  guard: GuardModeStore;
  scope: Accessor<Scope>;
  runActive: () => boolean;
  active: Accessor<boolean>;
  notify: (message: string, tone?: "info" | "success" | "warn" | "error") => void;
  onClose: () => void;
  onApplied: () => void;
}): JSX.Element {
  let applying = false;
  const current = () => deriveSafetyPreset(props.settings.effective(), props.guard.mode());

  const apply = async (preset: CanonicalSafetyPreset): Promise<void> => {
    if (applying) return;
    applying = true;
    try {
      const scope = props.scope();
      await applySafetyPreset(preset, {
        settings: props.settings,
        guard: props.guard,
        scope,
      });
      props.notify(
        `safety: ${preset} (${scope})${props.runActive() ? ` ${glyph("emDash")} applies to the next run` : ""}`,
        "success",
      );
      props.onApplied();
    } catch (error) {
      props.notify(`safety preset failed: ${errorText(error)}`, "error");
    } finally {
      applying = false;
    }
  };

  const confirmation = useArmedConfirm<PendingPreset>(props.interaction.keymap, {
    active: props.active,
    message: (pending) => pending.confirmation.message,
    acceptLabel: (pending) => pending.confirmation.confirmLabel,
    cancelLabel: (pending) => pending.confirmation.cancelLabel,
    onYes: (pending) => apply(pending.preset),
  });

  const choose = (choice: SafetyPresetChoice): void => {
    const preset = choice.value as CanonicalSafetyPreset;
    const request = safetyPresetConfirmation(preset, props.settings.effective().sandbox);
    if (request) {
      confirmation.arm({ preset, confirmation: request });
      return;
    }
    detachObserved("safety_preset_apply", () => apply(preset));
  };

  return (
    <ListPicker<SafetyPresetChoice>
      keymap={props.interaction.keymap}
      active={props.active}
      resetKey={props.active}
      title="Select safety preset"
      items={() => [...SAFETY_PRESET_CHOICES]}
      initialIndex={Math.max(
        0,
        SAFETY_PRESET_CHOICES.findIndex((choice) => choice.value === current()),
      )}
      idPrefix="safety-preset-"
      confirmLabel="use preset"
      onConfirm={choose}
      onClose={props.onClose}
      footer={() =>
        confirmation.message() ??
        `${props.scope()} settings ${glyph("separator")} direct presets run on the host`
      }
      footerFg={confirmation.message() ? tokens.del : tokens.muted}
      cells={(choice, selected) => [
        {
          width: CURRENT_COL_WIDTH,
          fg: choice.value === current() ? tokens.accent : tokens.muted,
          text: choice.value === current() ? glyph("radioOn") : glyph("radioOff"),
        },
        {
          width: LABEL_COL_WIDTH,
          fg: selected() ? tokens.fg : tokens.muted,
          text: choice.label,
        },
        { grow: true, marginLeft: 1, fg: tokens.muted, text: choice.detail },
      ]}
      preview={(choice) => (
        <box flexDirection="column">
          <Show
            when={confirmation.armed()?.confirmation}
            fallback={
              <>
                <text
                  fg={
                    choice.value === "free" || choice.value === "judged" ? tokens.warn : tokens.fg
                  }
                >
                  {choice.value === "free" || choice.value === "judged"
                    ? `${glyph("warning")} No sandbox boundary.`
                    : "Commands remain inside the Bubblewrap boundary."}
                </text>
                <text fg={tokens.muted}>
                  {choice.value === "judged" || choice.value === "reviewed"
                    ? "The LLM judge decides risky actions and asks you when unsure."
                    : choice.detail}
                </text>
              </>
            }
          >
            {(request: Accessor<SafetyPresetConfirmation>) => (
              <>
                <text fg={request().danger ? tokens.del : tokens.warn}>
                  {glyph("warning") + " " + request().message}
                </text>
                <For each={request().detail?.slice(0, 2)}>
                  {(line) => <text fg={tokens.muted}>{line}</text>}
                </For>
              </>
            )}
          </Show>
        </box>
      )}
    />
  );
}
