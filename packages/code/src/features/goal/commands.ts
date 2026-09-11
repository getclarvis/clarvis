import type { CommandScope, CommandUi, CommandRouteResult } from "../../keys/commands.ts";
import type { HintTone } from "../../views/hint.ts";
import { lazyView } from "../../views/config/lazy-view.tsx";
import { detachObserved } from "../../core/tasks.ts";
import { parseGoalCommand } from "./parser.ts";
import { createGoalDraft, type GoalDraft } from "./draft.ts";
import type { GoalController } from "./controller.ts";

/** Explicit user controls enter the goal service; the slash text never becomes a model prompt. */
export function registerGoalCommands(
  commands: CommandScope,
  deps: {
    goals: GoalController;
    ui: CommandUi;
    notify(message: string, tone?: HintTone): void;
  },
): void {
  let draft: GoalDraft | undefined;
  const view = lazyView(async () => {
    const { GoalView } = await import("./view.tsx");
    return (host) =>
      GoalView(host, {
        goals: deps.goals,
        initialDraft: draft,
        notify: (message) => deps.notify(message, "warn"),
      });
  });
  const open = (value?: GoalDraft): void => {
    draft = value;
    deps.ui.openView("goal.open", view);
  };
  const route = (raw: string): CommandRouteResult => {
    let command;
    try {
      command = parseGoalCommand(raw);
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : "Invalid goal command.", "warn");
      return "block";
    }
    detachObserved(
      "goal.command",
      async () => {
        const binding = deps.goals.binding();
        await deps.goals.refresh();
        const now = deps.goals.binding();
        if (binding?.sessionId !== now?.sessionId || binding?.generation !== now?.generation)
          throw new Error("The goal conversation changed. Enter the command again.");
        if (command.kind === "show") {
          open();
          return;
        }
        if (!deps.goals.available())
          throw new Error(deps.goals.failure() || "Goals are unavailable on this host.");
        const current = deps.goals.view()?.state.current;
        if (command.kind === "edit" || (command.kind === "create" && current !== undefined)) {
          const physical = deps.goals.view()?.physical_run;
          if (
            (physical !== undefined && physical.execution_state !== "closed") ||
            current?.runs.some((run) => run.phase !== "closed")
          )
            throw new Error("Wait for physical execution to end before reviewing this goal.");
          open(
            createGoalDraft(
              deps.goals.view(),
              binding,
              command.kind === "create" ? command.objective : undefined,
            ),
          );
          return;
        }
        try {
          await deps.goals.control(
            command.kind === "create" || command.kind === "pause"
              ? command
              : { kind: command.kind },
            undefined,
            binding,
          );
        } catch (error) {
          if (
            command.kind === "create" &&
            deps.goals.pendingOperation() === undefined &&
            deps.goals.view()?.state.current === undefined
          )
            open(createGoalDraft(deps.goals.view(), deps.goals.binding(), command.objective));
          throw error;
        }
        open();
      },
      (error) =>
        deps.notify(error instanceof Error ? error.message : "Goal command failed.", "warn"),
    );
    return true;
  };
  commands.registerAction({
    name: "goal.open",
    title: "Goal",
    slash: "/goal",
    surface: "slash",
    group: "actions",
    desc: "Inspect or control this conversation's persistent objective",
    args: [{ name: "<objective> | -- <literal objective>" }],
    subcommands: [
      { name: "edit", desc: "Review the objective, criteria and limits" },
      { name: "pause", desc: "Pause future stages; --running also cancels the bound run" },
      { name: "resume", desc: "Revalidate and resume within the remaining limits" },
      { name: "cancel", desc: "Cancel the goal and its bound execution" },
      { name: "clear", desc: "Archive and unlink an inactive goal" },
    ],
    run: () => {
      route("");
    },
    route,
  });
}
