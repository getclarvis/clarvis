import type { Accessor, JSX } from "solid-js";
import { For, Show } from "solid-js";
import type { SettingsAdapter } from "../../adapters/settings.ts";
import { deriveIsolation } from "../../adapters/execution-safety.ts";
import {
  applyIsolation,
  isolationConfirmation,
  isContainerIsolation,
  ISOLATION_CHOICES,
  type IsolationChoice,
  type IsolationConfirmation,
} from "../../features/run/isolation.ts";
import type { Interaction } from "../../keys/interaction.ts";
import { errorText } from "../../adapters/errors.ts";
import { detachObserved } from "../../core/tasks.ts";
import { glyph, glyphColWidth } from "../../theme/glyphs.ts";
import { tokens } from "../../theme/tokens.ts";
import { useArmedConfirm } from "../confirm.ts";
import { ListPicker } from "./ListPicker.tsx";

const CURRENT_COL_WIDTH = glyphColWidth("radioOn");
const LABEL_COL_WIDTH = 9;

interface PendingIsolation {
  isolation: IsolationChoice["value"];
  confirmation: IsolationConfirmation;
}

/** Quick picker for execution isolation; command review is intentionally separate. */
export function IsolationPicker(props: {
  interaction: Interaction;
  settings: SettingsAdapter;
  runActive: () => boolean;
  active: Accessor<boolean>;
  retryRuntime: () => void;
  notify: (message: string, tone?: "info" | "success" | "warn" | "error") => void;
  onClose: () => void;
  onApplied: () => void;
}): JSX.Element {
  let applying = false;
  const current = () => deriveIsolation(props.settings.effective());

  const apply = async (isolation: IsolationChoice["value"]): Promise<void> => {
    if (applying) return;
    applying = true;
    try {
      const effective = await applyIsolation(isolation, props.settings);
      if (isContainerIsolation(isolation)) props.retryRuntime();
      props.notify(
        `isolation: ${effective} (global)${props.runActive() ? ` ${glyph("emDash")} applies to the next run` : ""}`,
        "success",
      );
      props.onApplied();
    } catch (error) {
      props.notify(`isolation change failed: ${errorText(error)}`, "error");
    } finally {
      applying = false;
    }
  };

  const confirmation = useArmedConfirm<PendingIsolation>(props.interaction.keymap, {
    active: props.active,
    message: (pending) => pending.confirmation.message,
    acceptLabel: (pending) => pending.confirmation.confirmLabel,
    cancelLabel: (pending) => pending.confirmation.cancelLabel,
    onYes: (pending) => apply(pending.isolation),
  });

  const choose = (choice: IsolationChoice): void => {
    const request = isolationConfirmation(choice.value);
    if (request) {
      confirmation.arm({ isolation: choice.value, confirmation: request });
      return;
    }
    detachObserved("isolation_apply", () => apply(choice.value));
  };

  return (
    <ListPicker<IsolationChoice>
      keymap={props.interaction.keymap}
      active={props.active}
      resetKey={props.active}
      title="Select isolation"
      items={() => [...ISOLATION_CHOICES]}
      initialIndex={Math.max(
        0,
        ISOLATION_CHOICES.findIndex((choice) => choice.value === current()),
      )}
      idPrefix="isolation-"
      confirmLabel="use isolation"
      onConfirm={choose}
      onClose={props.onClose}
      footer={() =>
        confirmation.message() ??
        `global setting ${glyph("separator")} container engines start on first run`
      }
      footerFg={confirmation.message() ? tokens.del : tokens.muted}
      cells={(choice, selected) => [
        {
          width: CURRENT_COL_WIDTH,
          fg: choice.value === current() ? tokens.accent : tokens.muted,
          text: choice.value === current() ? glyph("radioOn") : glyph("radioOff"),
        },
        { width: LABEL_COL_WIDTH, fg: selected() ? tokens.fg : tokens.muted, text: choice.label },
        { grow: true, marginLeft: 1, fg: tokens.muted, text: choice.detail },
      ]}
      preview={(choice) => (
        <box flexDirection="column">
          <Show
            when={confirmation.armed()?.confirmation}
            fallback={
              <>
                <text fg={choice.value === "host" ? tokens.warn : tokens.fg}>
                  {choice.value === "host"
                    ? `${glyph("warning")} No containment boundary.`
                    : isContainerIsolation(choice.value)
                      ? "The managed Linux runtime is resolved lazily."
                      : "Uses the native host sandbox."}
                </text>
                <text fg={tokens.muted}>
                  {choice.value === "docker"
                    ? "If Docker cannot start, Clarvis reports it and requires Sandbox for this session."
                    : choice.value === "podman"
                      ? "If Podman cannot start, Clarvis reports it and does not fall back to Sandbox."
                      : choice.detail}
                </text>
              </>
            }
          >
            {(request: Accessor<IsolationConfirmation>) => (
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
