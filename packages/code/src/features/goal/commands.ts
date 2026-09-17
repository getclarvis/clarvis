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
  const openEditor = (value?: GoalDraft): void => {
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
          openEditor();
          return;
        }
        if (!deps.goals.available())
          throw new Error(deps.goals.failure() || "Goals are unavailable on this host.");
        const current = deps.goals.view()?.state.current;
        if (command.kind === "formulate") {
          if (current !== undefined)
            throw new Error(
              "A goal already exists; review, cancel or clear it before formulating another.",
            );
          deps.notify(
            command.mode === "auto"
              ? "Formulating a Goal from this conversation…"
              : "Formulating a Goal from your request…",
            "info",
          );
          const receipt = await deps.goals.formulate(command.mode, command.seed);
          if (receipt.formulation.outcome === "created")
            deps.notify("Goal created; the first work stage is starting.", "success");
          else
            deps.notify(
              receipt.formulation.question ??
                receipt.formulation.message ??
                "Goal formulation did not create a goal.",
              "warn",
            );
          return;
        }
        if (command.kind === "edit" || (command.kind === "create" && current !== undefined)) {
          const physical = deps.goals.view()?.physical_run;
          if (
            (physical !== undefined && physical.execution_state !== "closed") ||
            current?.runs.some((run) => run.phase !== "closed")
          )
            throw new Error("Wait for physical execution to end before reviewing this goal.");
          openEditor(
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
            openEditor(createGoalDraft(deps.goals.view(), deps.goals.binding(), command.objective));
          throw error;
        }
        deps.notify(
          command.kind === "create"
            ? "Literal Goal created; the first work stage is starting."
            : "Goal updated.",
          "success",
        );
      },
      (error) =>
        deps.notify(error instanceof Error ? error.message : "Goal command failed.", "warn"),
    );
    return true;
  };
  const current = () => deps.goals.view()?.state.current;
  const ready = () => deps.goals.available() && !deps.goals.busy();
  const physicallyBusy = () => {
    const physical = deps.goals.view()?.physical_run;
    return (
      (physical !== undefined && physical.execution_state !== "closed") ||
      (current()?.runs.some((run) => run.phase !== "closed") ?? false)
    );
  };
  commands.registerAction({
    name: "goal.open",
    title: "Goal",
    slash: "/goal",
    surface: "slash",
    group: "actions",
    desc: "Inspect or control this conversation's persistent objective",
    args: [{ name: "auto | <seed> | -- <literal objective>" }],
    subcommands: [
      {
        name: "auto",
        visible: () => ready() && current() === undefined,
        desc: "Formulate from this conversation's trajectory",
      },
      {
        name: "edit",
        visible: () => ready() && current() !== undefined && !physicallyBusy(),
        desc: "Review the objective, criteria and limits",
      },
      {
        name: "pause",
        visible: () => ready() && (current()?.status === "active" || physicallyBusy()),
        desc: "Pause future stages; --running also cancels the bound run",
      },
      {
        name: "resume",
        visible: () =>
          ready() &&
          current() !== undefined &&
          !["active", "complete", "cancelled"].includes(current()!.status) &&
          !physicallyBusy(),
        desc: "Revalidate and resume within the remaining limits",
      },
      {
        name: "cancel",
        visible: () =>
          ready() &&
          current() !== undefined &&
          !["complete", "cancelled"].includes(current()!.status),
        desc: "Cancel the goal and its bound execution",
      },
      {
        name: "clear",
        visible: () =>
          ready() && current() !== undefined && current()?.status !== "active" && !physicallyBusy(),
        desc: "Archive and unlink an inactive goal",
      },
    ],
    run: () => {
      route("");
    },
    route,
  });
}
