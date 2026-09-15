import type { Accessor, JSX } from "solid-js";
import { createSignal, Show } from "solid-js";
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

type IsolationApplyState =
  { phase: "saving" | "reconnecting"; label: string } | { phase: "failed"; message: string };

/** Quick picker for execution isolation; command review is intentionally separate. */
export function IsolationPicker(props: {
  interaction: Interaction;
  settings: SettingsAdapter;
  runActive: () => boolean;
  active: Accessor<boolean>;
  notify: (message: string, tone?: "info" | "success" | "warn" | "error") => void;
  reload: () => Promise<{ ok: boolean; message: string }>;
  restore?: (isolation: IsolationChoice["value"]) => Promise<{ ok: boolean; message: string }>;
  onClose: () => void;
  onApplied: () => void;
}): JSX.Element {
  const [applyState, setApplyState] = createSignal<IsolationApplyState>();
  const applying = (): boolean => {
    const state = applyState();
    return state?.phase === "saving" || state?.phase === "reconnecting";
  };
  const failure = (): Extract<IsolationApplyState, { phase: "failed" }> | undefined => {
    const state = applyState();
    return state?.phase === "failed" ? state : undefined;
  };
  const current = () => deriveIsolation(props.settings.effective());

  const apply = async (isolation: IsolationChoice["value"]): Promise<void> => {
    if (applying()) return;
    if (props.runActive()) {
      props.notify(
        "isolation change unavailable while activity is running; stop it before reconnecting",
        "warn",
      );
      return;
    }
    const label =
      ISOLATION_CHOICES.find((choice) => choice.value === isolation)?.label ?? isolation;
    const previous = current();
    setApplyState({ phase: "saving", label });
    let saved = false;
    const restorePrevious = async (message: string): Promise<void> => {
      const reason = message.replace(/[.\s]+$/u, "");
      try {
        if (props.restore === undefined) {
          await applyIsolation(previous, props.settings);
        } else {
          const restored = await props.restore(previous);
          if (!restored.ok) throw new Error(restored.message);
        }
        const previousLabel =
          ISOLATION_CHOICES.find((choice) => choice.value === previous)?.label ?? previous;
        setApplyState({
          phase: "failed",
          message: `${reason}. Kept ${previousLabel}.`,
        });
        props.notify(`isolation unchanged: ${reason}`, "warn");
      } catch (rollbackError) {
        const rollbackMessage = errorText(rollbackError);
        setApplyState({
          phase: "failed",
          message: `${reason}. Restoring ${previous} failed: ${rollbackMessage}`,
        });
        props.notify(
          `isolation saved, pending reconnect: ${reason}; rollback failed: ${rollbackMessage}`,
          "warn",
        );
      }
    };
    try {
      const effective = await applyIsolation(isolation, props.settings);
      saved = true;
      setApplyState({ phase: "reconnecting", label });
      const reloaded = await props.reload();
      if (!reloaded.ok) {
        await restorePrevious(reloaded.message);
        return;
      }
      setApplyState(undefined);
      props.notify(`isolation: ${effective} (global)`, "success");
      props.onApplied();
    } catch (error) {
      const message = errorText(error);
      if (saved) {
        await restorePrevious(message);
        return;
      }
      setApplyState(undefined);
      props.notify(`isolation change failed: ${message}`, "error");
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

  const footer = (): string => {
    const state = applyState();
    if (state?.phase === "saving") return `Saving isolation ${state.label}${glyph("ellipsis")}`;
    if (state?.phase === "reconnecting")
      return `Reconnecting to ${state.label}${glyph("ellipsis")}`;
    if (state?.phase === "failed") return "";
    if (confirmation.armed() !== null) return "";
    return "";
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
      locked={applying}
      confirmationActive={() => confirmation.armed() !== null}
      onConfirm={choose}
      onClose={props.onClose}
      footer={footer}
      footerFg={
        applyState()?.phase === "failed"
          ? tokens.del
          : confirmation.message()
            ? tokens.del
            : tokens.muted
      }
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
            when={failure()}
            fallback={
              <Show
                when={confirmation.armed()?.confirmation}
                fallback={
                  <text
                    fg={choice.value === "host" ? tokens.warn : tokens.muted}
                    height={2}
                    flexShrink={0}
                    wrapMode="word"
                  >
                    {[
                      choice.value === "host"
                        ? `${glyph("warning")} No containment boundary.`
                        : isContainerIsolation(choice.value)
                          ? "Full native Kernel; extensions and external capability providers are unavailable."
                          : "Uses the native host sandbox.",
                      choice.value === "docker"
                        ? "If Docker cannot start, Clarvis reports the failure and does not run natively."
                        : choice.value === "podman"
                          ? "If Podman cannot start, Clarvis reports the failure and does not run natively."
                          : choice.detail,
                    ].join(" ")}
                  </text>
                }
              >
                {(request: Accessor<IsolationConfirmation>) => (
                  <text
                    fg={request().danger ? tokens.del : tokens.warn}
                    height={2}
                    flexShrink={0}
                    wrapMode="word"
                  >
                    {[glyph("warning") + " " + request().message, ...(request().detail ?? [])]
                      .join(" ")
                      .trim()}
                  </text>
                )}
              </Show>
            }
          >
            {(state: Accessor<Extract<IsolationApplyState, { phase: "failed" }>>) => (
              <text fg={tokens.del} height={2} flexShrink={0} wrapMode="word">
                {`${glyph("error")} Reconnect failed: ${state().message}`}
              </text>
            )}
          </Show>
        </box>
      )}
    />
  );
}
