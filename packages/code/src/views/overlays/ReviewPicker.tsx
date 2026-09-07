import type { Accessor, JSX } from "solid-js";
import type { Scope } from "@clarvis/protocol";
import type { SettingsAdapter } from "../../adapters/settings.ts";
import type { GuardModeStore } from "../../adapters/guard-mode.ts";
import { applyReviewMode, REVIEW_CHOICES, type ReviewChoice } from "../../features/run/review.ts";
import type { Interaction } from "../../keys/interaction.ts";
import { errorText } from "../../adapters/errors.ts";
import { detachObserved } from "../../core/tasks.ts";
import { glyph, glyphColWidth } from "../../theme/glyphs.ts";
import { tokens } from "../../theme/tokens.ts";
import { ListPicker } from "./ListPicker.tsx";

const CURRENT_COL_WIDTH = glyphColWidth("radioOn");
const LABEL_COL_WIDTH = 10;

/** Quick picker for command review, independent from the execution boundary. */
export function ReviewPicker(props: {
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

  const apply = async (choice: ReviewChoice): Promise<void> => {
    if (applying) return;
    applying = true;
    try {
      const scope = props.scope();
      const result = await applyReviewMode(choice.value, {
        settings: props.settings,
        guard: props.guard,
        scope,
      });
      props.notify(
        result.degraded
          ? `review: approval (${scope}) ${glyph("emDash")} Auto needs a usable default model`
          : `review: ${choice.label.toLowerCase()} (${scope})${props.runActive() ? ` ${glyph("emDash")} applies to the next run` : ""}`,
        result.degraded ? "warn" : "success",
      );
      props.onApplied();
    } catch (error) {
      props.notify(`review change failed: ${errorText(error)}`, "error");
    } finally {
      applying = false;
    }
  };

  return (
    <ListPicker<ReviewChoice>
      keymap={props.interaction.keymap}
      active={props.active}
      resetKey={props.active}
      title="Select command review"
      items={() => [...REVIEW_CHOICES]}
      initialIndex={Math.max(
        0,
        REVIEW_CHOICES.findIndex((choice) => choice.value === props.guard.mode()),
      )}
      idPrefix="review-"
      confirmLabel="use review"
      onConfirm={(choice) => detachObserved("review_apply", () => apply(choice))}
      onClose={props.onClose}
      footer={() => `${props.scope()} setting ${glyph("separator")} isolation is unchanged`}
      cells={(choice, selected) => [
        {
          width: CURRENT_COL_WIDTH,
          fg: choice.value === props.guard.mode() ? tokens.accent : tokens.muted,
          text: choice.value === props.guard.mode() ? glyph("radioOn") : glyph("radioOff"),
        },
        { width: LABEL_COL_WIDTH, fg: selected() ? tokens.fg : tokens.muted, text: choice.label },
        { grow: true, marginLeft: 1, fg: tokens.muted, text: choice.detail },
      ]}
      preview={(choice) => (
        <box flexDirection="column">
          <text fg={choice.value === "off" ? tokens.warn : tokens.fg}>
            {choice.value === "off"
              ? `${glyph("warning")} Commands are not reviewed.`
              : choice.value === "on"
                ? "Clarvis asks you before risky commands."
                : "The configured LLM judge reviews commands first."}
          </text>
          <text fg={tokens.muted}>The selected Isolation boundary does not change.</text>
        </box>
      )}
    />
  );
}
