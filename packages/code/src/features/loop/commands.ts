import type { CommandScope, CommandUi, CommandRouteResult } from "../../keys/commands.ts";
import type { HintTone } from "../../views/hint.ts";
import { lazyView } from "../../views/config/lazy-view.tsx";
import type { LoopController } from "./controller.ts";
import { parseLoopCommand } from "./parser.ts";

/** Register deterministic /loop operations without a model, tool, skill or shell dispatch. */
export function registerLoopCommands(
  commands: CommandScope,
  deps: {
    loops: LoopController;
    ui: CommandUi;
    notify(message: string, tone?: HintTone): void;
  },
): void {
  let selectedId: string | undefined;
  const view = lazyView(async () => {
    const { LoopView } = await import("./view.tsx");
    return (host) =>
      LoopView(host, {
        loops: deps.loops,
        initialId: selectedId,
        notify: (message, tone) => deps.notify(message, tone),
      });
  });
  const open = (id?: string): void => {
    selectedId = id;
    deps.ui.openView("loop.open", view);
  };
  const route = (args: string): CommandRouteResult => {
    try {
      const command = parseLoopCommand(args);
      switch (command.kind) {
        case "list":
          open();
          break;
        case "create":
          open(deps.loops.create(command).id);
          break;
        case "show":
          open(deps.loops.get(command.id).id);
          break;
        case "pause":
          deps.loops.pause(command.id);
          deps.notify(`${command.id} paused.`, "info");
          break;
        case "resume":
          open(deps.loops.resume(command.id).id);
          break;
        case "cancel":
          deps.loops.cancel(command.id, command.running);
          deps.notify(
            `${command.id} cancelled${command.running ? "; cancellation requested for its own active run" : "; any active run may finish"}.`,
            "info",
          );
          break;
      }
      return true;
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), "warn");
      return "block";
    }
  };
  commands.registerAction({
    name: "loop.open",
    title: "Loop",
    slash: "/loop",
    surface: "slash",
    group: "actions",
    desc: "Repeat an explicit prompt between turns, while this TUI is open",
    args: [{ name: '<duration> <prompt> | cron "<expression>" <prompt>' }],
    subcommands: [
      { name: "list", desc: "List this conversation's loops" },
      { name: "show", desc: "Inspect a loop" },
      { name: "pause", desc: "Pause future occurrences" },
      { name: "resume", desc: "Revalidate and resume a paused loop" },
      { name: "cancel", desc: "Cancel a loop; --running also cancels its own run" },
    ],
    run: () => open(),
    route,
  });
}
