import { createSignal, For, Show, type Accessor, type JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { GoalControlAction, GoalRecord } from "@clarvis/protocol";
import type { ViewHost } from "../../keys/commands.ts";
import { tokens } from "../../theme/tokens.ts";
import { scrollbarOptions } from "../../theme/surfaces.ts";
import { bindLevelKeys, createFieldEditor, ViewFrame } from "../../views/config/view-host.tsx";
import { registerLevel } from "../../ui/patterns/level-keys.ts";
import { detachObserved } from "../../core/tasks.ts";
import type { GoalController } from "./controller.ts";
import { createGoalDraft, type GoalDraft } from "./draft.ts";
import { GoalForm } from "./form.tsx";

/** Only the host's acceptance for this criterion and objective revision satisfies human review. */
function humanAccepted(goal: GoalRecord, criterionId: string): boolean {
  return goal.human_acceptances.some(
    (acceptance) =>
      acceptance.criterion_id === criterionId &&
      acceptance.objective_revision === goal.objective_revision,
  );
}

/** Goal state, physical work and evidence remain separate projections of the host's canonical view. */
export function GoalView(
  host: ViewHost,
  deps: {
    goals: GoalController;
    initialDraft?: GoalDraft;
    notify(message: string): void;
  },
): JSX.Element {
  const { goals } = deps;
  const [draft, setDraft] = createSignal<GoalDraft | undefined>(deps.initialDraft);
  const editor = createFieldEditor(host.interaction, () => host.active() && draft() === undefined);
  let scroll: ScrollBoxRenderable | undefined;
  const goal = () => goals.view()?.state.current;
  const pendingHumanCriteria = () => {
    const current = goal();
    return (
      current?.criteria.filter(
        (criterion) => criterion.kind === "human" && !humanAccepted(current, criterion.id),
      ) ?? []
    );
  };
  const physicallyBusy = (): boolean => {
    const physical = goals.view()?.physical_run;
    return (
      (physical !== undefined && physical.execution_state !== "closed") ||
      (goal()?.runs.some((run) => run.phase !== "closed") ?? false)
    );
  };
  const report = (error: unknown): void =>
    deps.notify(error instanceof Error ? error.message : "Goal operation failed.");
  const act = (action: GoalControlAction): void =>
    detachObserved(
      "goal.control",
      async () => {
        await goals.control(action);
      },
      report,
    );
  const edit = (): void => {
    setDraft(createGoalDraft(goals.view(), goals.binding()));
  };
  const accept = (): void => {
    const current = goal();
    const revision = goals.view()?.state.revision;
    const binding = goals.binding();
    if (current === undefined || revision === undefined) return;
    editor.startPick(
      "Human approval",
      pendingHumanCriteria().map((criterion) => ({
        label: criterion.description,
        value: criterion.id,
      })),
      (criterionId) => {
        detachObserved(
          "goal.accept",
          async () => {
            const criterion = current.criteria.find((item) => item.id === criterionId)!;
            if (
              !(await host.confirm({
                message: "Accept this goal criterion?",
                confirmLabel: "accept",
                detail: [
                  current.objective,
                  criterion.description,
                  "Your acceptance applies to this objective revision.",
                ],
              }))
            )
              return;
            await goals.control(
              {
                kind: "accept",
                criterion_id: criterionId,
                objective_revision: current.objective_revision,
              },
              revision,
              binding,
            );
          },
          report,
        );
      },
    );
  };
  bindLevelKeys({
    host,
    editor,
    suspend: () => draft() !== undefined,
    register: (enabled) =>
      registerLevel(host.interaction.keymap, {
        enabled,
        scroll: () => scroll,
        verbs: [
          {
            key: "e",
            label: "edit goal",
            when: () => goals.available() && !goals.busy() && !physicallyBusy(),
            run: edit,
          },
          {
            key: "p",
            label: "pause next stages",
            when: () => goal()?.status === "active" && !goals.busy(),
            run: () => act({ kind: "pause" }),
          },
          {
            key: "x",
            label: "pause + stop run",
            when: () => goal() !== undefined && physicallyBusy() && !goals.busy(),
            run: () => act({ kind: "pause", running: true }),
          },
          {
            key: "r",
            label: "resume",
            when: () =>
              goal() !== undefined &&
              !["active", "complete", "cancelled"].includes(goal()!.status) &&
              !physicallyBusy() &&
              !goals.busy(),
            run: () => act({ kind: "resume" }),
          },
          {
            key: "c",
            label: "cancel goal",
            when: () =>
              goal() !== undefined &&
              !["complete", "cancelled"].includes(goal()!.status) &&
              !goals.busy(),
            run: () => act({ kind: "cancel" }),
          },
          {
            key: "d",
            label: "archive goal",
            when: () =>
              goal() !== undefined &&
              goal()?.status !== "active" &&
              !physicallyBusy() &&
              !goals.busy(),
            run: () => act({ kind: "clear" }),
          },
          {
            key: "a",
            label: "human acceptance",
            when: () =>
              goal() !== undefined &&
              !["complete", "cancelled"].includes(goal()!.status) &&
              pendingHumanCriteria().length > 0 &&
              !goals.busy(),
            run: accept,
          },
          {
            key: "f",
            label: "refresh",
            run: () => detachObserved("goal.refresh", () => goals.refresh(), report),
          },
          {
            key: "u",
            label: "recover receipt",
            when: () => goals.pendingOperation() !== undefined && !goals.busy(),
            run: () => detachObserved("goal.recover", () => goals.recover(), report),
          },
        ],
      }),
  });
  return (
    <Show
      when={draft()}
      fallback={
        <ViewFrame
          host={host}
          title="Goal"
          unscoped
          purpose="One objective for this conversation. The host continues while authorized and within its limits."
        >
          <Show when={goals.failure()}>
            <text fg={tokens.warn}>{goals.failure()}</text>
          </Show>
          <Show when={goals.pendingOperation()}>
            <text fg={tokens.warn}>
              A previous change is unconfirmed. Recover its receipt before making another change.
            </text>
          </Show>
          <Show when={goals.loading() && goal() === undefined}>
            <text fg={tokens.muted}>Reading goal state...</text>
          </Show>
          <Show
            when={goal()}
            fallback={
              <text fg={tokens.muted}>
                No goal in this conversation. Use /goal &lt;objective&gt; to create one.
              </text>
            }
          >
            {(current: Accessor<GoalRecord>) => (
              <scrollbox
                ref={(value) => {
                  scroll = value;
                }}
                flexGrow={1}
                minHeight={0}
                verticalScrollbarOptions={scrollbarOptions()}
              >
                <text fg={tokens.fg}>{current().objective}</text>
                <text
                  fg={tokens.accent}
                >{`Goal: ${current().status}${current().reason ? ` (${current().reason})` : ""}`}</text>
                <text
                  fg={tokens.fg}
                >{`Physical execution: ${goals.view()?.physical_run?.execution_state ?? current().runs.findLast((run) => run.phase !== "closed")?.phase ?? "none"}${goals.view()?.physical_run?.execution_id ? ` · ${goals.view()!.physical_run!.execution_id}` : ""}`}</text>
                <Show
                  when={
                    goals.view()?.physical_run?.attention !== undefined &&
                    goals.view()?.physical_run?.attention !== "none"
                  }
                >
                  <text
                    fg={tokens.warn}
                  >{`Execution attention: ${goals.view()?.physical_run?.attention}`}</text>
                </Show>
                <Show when={goals.view()?.attention}>
                  <text fg={tokens.warn}>{goals.view()?.attention}</text>
                </Show>
                <text
                  fg={tokens.fg}
                >{`Net tokens: ${current().consumption.net_tokens} / ${current().limits.max_net_tokens}${current().consumption.usage_unknown ? " · usage incomplete" : ""}${current().consumption.cache_estimated ? " · cache estimated" : ""}`}</text>
                <text
                  fg={tokens.muted}
                >{`Input ${current().consumption.input} · cached ${current().consumption.cached ?? "unknown"} · output ${current().consumption.output} · overrun ${current().consumption.overrun_tokens}`}</text>
                <text
                  fg={tokens.fg}
                >{`Automatic continuations: ${current().auto_continuations} / ${current().limits.max_auto_continuations}`}</text>
                <text
                  fg={tokens.fg}
                >{`Checkpoints without progress: ${current().no_progress_checkpoints} / ${current().limits.max_no_progress_checkpoints}`}</text>
                <text
                  fg={tokens.fg}
                >{`Deadline: ${current().limits.deadline_at === undefined ? "none" : new Date(current().limits.deadline_at!).toISOString()}`}</text>
                <text fg={tokens.accent} marginTop={1}>
                  Criteria
                </text>
                <Show when={current().criteria.length === 0}>
                  <text fg={tokens.fg}>{`Model assessment: ${current().objective}`}</text>
                </Show>
                <For each={current().criteria}>
                  {(criterion) => (
                    <text
                      fg={tokens.fg}
                    >{`${criterion.kind === "qualitative" ? "Model assessment" : criterion.kind === "human" ? `Human approval (${humanAccepted(current(), criterion.id) ? "accepted" : "pending"})` : "Host check"}: ${criterion.description}`}</text>
                  )}
                </For>
                <Show when={current().candidate}>
                  <text
                    fg={tokens.muted}
                  >{`Completion candidate: ${current().candidate!.summary}`}</text>
                </Show>
                <Show when={current().runs.at(-1)?.progress}>
                  <text
                    fg={tokens.fg}
                  >{`Progress: ${current().runs.at(-1)!.progress!.summary}`}</text>
                </Show>
                <Show when={current().runs.at(-1)?.checkpoint}>
                  <text
                    fg={tokens.fg}
                  >{`Checkpoint: ${current().runs.at(-1)!.checkpoint!.summary}\nNext: ${current().runs.at(-1)!.checkpoint!.next_step}`}</text>
                </Show>
                <text
                  fg={tokens.muted}
                >{`${current().runs.length} stages · ${goals.view()?.state.archive.length ?? 0} archived goals`}</text>
                <text fg={tokens.muted}>
                  A saved checkpoint ends one stage. Goal completion is a separate host decision;
                  model assessment is not independent verification.
                </text>
              </scrollbox>
            )}
          </Show>
          <Show when={editor.editing()}>{editor.EditInput()}</Show>
          {editor.PickerInput()}
        </ViewFrame>
      }
    >
      {(value: Accessor<GoalDraft>) =>
        GoalForm(host, {
          goals,
          draft: value(),
          close: () => setDraft(undefined),
          notify: (message) => deps.notify(message),
        })
      }
    </Show>
  );
}
