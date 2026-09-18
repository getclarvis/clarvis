import { createSignal, For, Show, type Accessor, type JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { GoalControlAction, GoalRecord, GoalStewardReview } from "@clarvis/protocol";
import type { ViewHost } from "../../keys/commands.ts";
import {
  detailCloseActions,
  DetailColumn,
  DetailTitle,
  DetailHeading,
} from "../../ui/patterns/detail-view.tsx";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import { scrollbarOptions } from "../../theme/surfaces.ts";
import { bindLevelKeys, createFieldEditor, ViewFrame } from "../../views/config/view-host.tsx";
import { registerLevel } from "../../ui/patterns/level-keys.ts";
import { detachObserved } from "../../core/tasks.ts";
import type { GoalController } from "./controller.ts";
import { createGoalDraft, type GoalDraft } from "./draft.ts";
import { GoalForm } from "./form.tsx";
import {
  compactGoalCount,
  compactSourceDigest,
  goalStatusPresentation,
  stewardStatusLabel,
} from "./presentation.ts";

/** Only the host's acceptance for this criterion and objective revision satisfies human review. */
function humanAccepted(goal: GoalRecord, criterionId: string): boolean {
  return goal.human_acceptances.some(
    (acceptance) =>
      acceptance.criterion_id === criterionId &&
      acceptance.objective_revision === goal.objective_revision,
  );
}

function visibleCriteria(goal: GoalRecord): GoalRecord["criteria"] {
  const objective = goal.objective.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
  return goal.criteria.filter(
    (criterion) =>
      criterion.kind !== "qualitative" ||
      criterion.description.trim().replace(/\s+/gu, " ").toLocaleLowerCase() !== objective,
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
  const executionState = (): string | undefined =>
    goals.view()?.physical_run?.execution_state ??
    goal()?.runs.findLast((run) => run.phase !== "closed")?.phase;
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
        ...detailCloseActions("<leader>o", () => host.close()),
        verbs: [
          {
            key: "e",
            label: "edit",
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
            label: "cancel",
            when: () =>
              goal() !== undefined &&
              !["complete", "cancelled"].includes(goal()!.status) &&
              !goals.busy(),
            run: () => act({ kind: "cancel" }),
          },
          {
            key: "d",
            label: "archive",
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
        <ViewFrame host={host} title="Goal" unscoped>
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
                <DetailColumn>
                  <DetailTitle>{current().objective}</DetailTitle>
                  <text marginTop={1} fg={goalStatusPresentation(current().status).color}>
                    {`${goalStatusPresentation(current().status).label} ${glyph("separator")} ${current().runs.length} stage${current().runs.length === 1 ? "" : "s"} ${glyph("separator")} ${current().origin.kind}`}
                  </text>
                  <Show when={current().status !== "complete" && current().reason}>
                    <text fg={tokens.warn}>{current().reason}</text>
                  </Show>
                  <Show when={stewardStatusLabel(current())}>
                    <text
                      marginTop={1}
                      fg={tokens.accent}
                    >{`Steward  ${stewardStatusLabel(current())}`}</text>
                    <text
                      fg={tokens.muted}
                    >{`${current().runs.at(-1)?.steward_review_count ?? 0} reviews ${glyph("separator")} ${current().runs.at(-1)?.steward_intervention_count ?? 0} interventions`}</text>
                    <Show when={current().runs.at(-1)?.steward_reviews?.at(-1)}>
                      {(review: Accessor<GoalStewardReview>) => (
                        <>
                          <text marginTop={1} fg={tokens.fg} wrapMode="word">
                            {review().summary}
                          </text>
                          <Show when={review().next_step ?? review().guidance}>
                            <text marginTop={1} fg={tokens.warn} wrapMode="word">
                              {`Next step: ${review().next_step ?? review().guidance}`}
                            </text>
                          </Show>
                        </>
                      )}
                    </Show>
                  </Show>
                  <Show when={executionState() !== undefined && executionState() !== "closed"}>
                    <text fg={tokens.fg}>{`Run ${executionState()}`}</text>
                  </Show>
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
                  <DetailHeading>Usage</DetailHeading>
                  <text fg={tokens.muted}>
                    {`Budget ${compactGoalCount(current().consumption.net_tokens)} / ${compactGoalCount(current().limits.max_net_tokens)} tokens ${glyph("separator")} ${current().auto_continuations} / ${current().limits.max_auto_continuations} continuations`}
                  </text>
                  <Show when={visibleCriteria(current()).length > 0}>
                    <DetailHeading>Criteria</DetailHeading>
                    <For each={visibleCriteria(current())}>
                      {(criterion) => (
                        <text fg={tokens.fg} wrapMode="word">
                          {`${criterion.kind === "human" ? (humanAccepted(current(), criterion.id) ? "✓" : "○") : "•"} ${criterion.description}${criterion.kind === "human" ? ` ${glyph("separator")} approval ${humanAccepted(current(), criterion.id) ? "accepted" : "needed"}` : criterion.kind === "host" ? ` ${glyph("separator")} host check` : ""}`}
                        </text>
                      )}
                    </For>
                  </Show>
                  <Show when={current().constraints.length > 0}>
                    <DetailHeading>Constraints</DetailHeading>
                    <For each={current().constraints}>
                      {(item) => <text fg={tokens.fg}>{`- ${item}`}</text>}
                    </For>
                  </Show>
                  <Show when={current().exclusions.length > 0}>
                    <DetailHeading>Exclusions</DetailHeading>
                    <For each={current().exclusions}>
                      {(item) => <text fg={tokens.fg}>{`- ${item}`}</text>}
                    </For>
                  </Show>
                  <Show when={current().assumptions.length > 0}>
                    <DetailHeading>Assumptions</DetailHeading>
                    <For each={current().assumptions}>
                      {(item) => <text fg={tokens.fg}>{`- ${item}`}</text>}
                    </For>
                  </Show>
                  <Show when={current().sources.length > 0}>
                    <DetailHeading>Normative sources</DetailHeading>
                    <For each={current().sources}>
                      {(source) => (
                        <text fg={tokens.fg} wrapMode="word">
                          {`${source.path} ${glyph("separator")} ${compactSourceDigest(source.digest)}`}
                        </text>
                      )}
                    </For>
                  </Show>
                </DetailColumn>
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
