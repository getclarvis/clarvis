import { createSignal, onCleanup, Show, type JSX } from "solid-js";
import type { GoalLimits } from "@clarvis/protocol";
import type { ViewHost } from "../../keys/commands.ts";
import { tokens } from "../../theme/tokens.ts";
import {
  bindLevelKeys,
  createFieldEditor,
  FieldRow,
  SelectableList,
  ViewFrame,
} from "../../views/config/view-host.tsx";
import { registerLevel } from "../../ui/patterns/level-keys.ts";
import { detachObserved } from "../../core/tasks.ts";
import type { GoalController } from "./controller.ts";
import { editGoalCriterion } from "./criterion-editor.ts";
import { goalDraftAction, type GoalDraft } from "./draft.ts";

/** A deterministic review of objective, criteria and finite limits, submitted as one CAS mutation. */
export function GoalForm(
  host: ViewHost,
  deps: {
    goals: GoalController;
    draft: GoalDraft;
    close(): void;
    notify(message: string): void;
  },
): JSX.Element {
  const [draft, setDraft] = createSignal(structuredClone(deps.draft));
  const [selection, setSelection] = createSignal(0);
  const editor = createFieldEditor(host.interaction, host.active);
  const report = (error: unknown): void =>
    deps.notify(error instanceof Error ? error.message : "Goal change failed.");
  const update = (patch: Partial<GoalDraft>): void => {
    setDraft((value) => ({ ...value, ...patch }));
    host.markDirty();
  };
  const limit = (key: keyof GoalLimits, label: string): void =>
    editor.startNumber(label, draft().limits[key], {
      min: key === "max_auto_continuations" ? 0 : 1,
      max: Number.MAX_SAFE_INTEGER - 1,
      notify: (message) => deps.notify(message),
      commit: (value) => {
        if (value !== undefined && !Number.isSafeInteger(value)) {
          deps.notify("Enter a whole number.");
          return;
        }
        if (value === undefined && draft().kind === "edit") {
          deps.notify("Enter the revised limit explicitly.");
          return;
        }
        update({ limits: { ...draft().limits, [key]: value } });
      },
    });
  const criterion = (index?: number): void =>
    editGoalCriterion({ editor, draft, update, notify: (message) => deps.notify(message) }, index);
  const save = async (): Promise<void> => {
    if (deps.goals.busy()) return;
    const value = draft();
    const action = goalDraftAction(value);
    if (action === undefined) {
      host.markDirty(false);
      deps.close();
      return;
    }
    if (
      value.kind === "replace" &&
      !(await host.confirm({
        message: "Replace this conversation's goal?",
        confirmLabel: "replace and start",
        detail: [
          `Current: ${value.previousObjective ?? ""}`,
          `New: ${value.objective}`,
          "The previous goal and its usage remain in the audit history.",
        ],
      }))
    )
      return;
    await deps.goals.control(action, value.expectedRevision, value.binding);
    host.markDirty(false);
    deps.close();
  };
  host.onSave(save);
  host.onCancel(() => {
    host.markDirty(false);
    deps.close();
  });
  onCleanup(() => {
    host.onSave(() => {});
    host.onCancel(() => {});
    host.markDirty(false);
  });
  const fields = () => [
    {
      label: "Objective",
      value: draft().objective || "required",
      edit: () =>
        editor.startMultiline("Objective", draft().objective, (objective) => update({ objective })),
    },
    {
      label: "Net tokens",
      value: String(draft().limits.max_net_tokens ?? "host entry budget"),
      edit: () => limit("max_net_tokens", "Total net tokens"),
    },
    {
      label: "Continuations",
      value: String(draft().limits.max_auto_continuations ?? "8 (host default)"),
      edit: () => limit("max_auto_continuations", "Automatic continuations"),
    },
    {
      label: "No progress",
      value: String(draft().limits.max_no_progress_checkpoints ?? "3 (host default)"),
      edit: () => limit("max_no_progress_checkpoints", "Consecutive checkpoints without progress"),
    },
    {
      label: "Deadline",
      value:
        draft().limits.deadline_at === undefined
          ? "none"
          : new Date(draft().limits.deadline_at!).toISOString(),
      edit: () =>
        editor.start(
          "Absolute deadline (ISO with timezone)",
          draft().limits.deadline_at === undefined
            ? ""
            : new Date(draft().limits.deadline_at!).toISOString(),
          (value) => {
            const deadline = value.trim() ? Date.parse(value) : undefined;
            if (
              (deadline !== undefined &&
                (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(deadline))) ||
              (deadline === undefined &&
                draft().kind === "edit" &&
                draft().limits.deadline_at !== undefined)
            ) {
              deps.notify("Enter an explicit ISO deadline with timezone.");
              return;
            }
            update({ limits: { ...draft().limits, deadline_at: deadline } });
          },
        ),
    },
    ...draft().criteria.map((item, index) => ({
      label:
        item.kind === "host"
          ? "Host check"
          : item.kind === "human"
            ? "Human approval"
            : "Model assessment",
      value: item.description,
      edit: () => criterion(index),
    })),
    {
      label: "Add criterion",
      value: "Model assessment, human approval, tool or artifact",
      edit: () => criterion(),
    },
  ];
  bindLevelKeys({
    host,
    editor,
    suspend: deps.goals.busy,
    register: (enabled) =>
      registerLevel(host.interaction.keymap, {
        enabled,
        nav: {
          count: () => fields().length,
          index: selection,
          setIndex: setSelection,
          activate: { label: "edit", run: () => fields()[selection()]?.edit() },
        },
        verbs: [
          {
            key: "ctrl+s",
            label: valueLabel(),
            run: () => detachObserved("goal.save", save, report),
          },
          {
            key: "delete",
            label: "remove criterion",
            when: () => selection() >= 5 && selection() < fields().length - 1,
            run: () =>
              update({
                criteria: draft().criteria.filter((_value, index) => index !== selection() - 5),
              }),
          },
        ],
      }),
  });
  function valueLabel(): string {
    return draft().kind === "edit" ? "save goal" : "review and start";
  }
  return (
    <ViewFrame
      host={host}
      title={draft().kind === "edit" ? "Edit goal" : "Review goal"}
      unscoped
      purpose="Limits apply to the whole goal, including automatic stages and delegated work."
    >
      <Show when={draft().previousObjective && draft().kind === "replace"}>
        <text fg={tokens.muted}>{`Replacing: ${draft().previousObjective}`}</text>
      </Show>
      <SelectableList
        each={fields}
        sel={selection}
        idPrefix="goal-field-"
        maxRows={10}
        row={(field, index) => (
          <FieldRow
            label={field.label}
            value={field.value.replace(/\s+/gu, " ")}
            selected={selection() === index()}
          />
        )}
      />
      <text fg={tokens.muted}>
        The host stops continuation at the limits. Work already in flight can overshoot the token
        limit.
      </text>
      <Show when={editor.editing()}>{editor.EditInput()}</Show>
      {editor.PickerInput()}
    </ViewFrame>
  );
}
