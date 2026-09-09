import type { CommandScope, CommandUi, CommandRouteResult } from "../../keys/commands.ts";
import { detachObserved } from "../../core/tasks.ts";
import type { HintTone } from "../../views/hint.ts";
import { lazyView } from "../../views/config/lazy-view.tsx";
import type { BackgroundController } from "./controller.ts";

/** Register the explicit handoff and recovery routes; scheduled/model text never enters this path. */
export function registerBackgroundCommands(
  commands: CommandScope,
  deps: {
    backgrounds: BackgroundController;
    ui: CommandUi;
    notify(message: string, tone?: HintTone): void;
    canExit?: () => boolean;
  },
): { offer(canOpen: () => boolean): Promise<void> } {
  let startup = false;
  const view = lazyView(async () => {
    const { BackgroundView } = await import("./view.tsx");
    return (host) => BackgroundView(host, { ...deps, startup });
  });
  const open = (atStartup = false): void => {
    startup = atStartup;
    deps.ui.openView("background.open", view);
  };
  const act = (operation: () => Promise<void>): void =>
    detachObserved("background.command", operation, (error) =>
      deps.notify(error instanceof Error ? error.message : String(error), "warn"),
    );
  const backgroundRoute = (args: string): CommandRouteResult => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) act(() => deps.backgrounds.background(deps.canExit));
    else if (parts.length === 1 && parts[0] === "list") open();
    else if (parts.length === 2 && parts[0] === "cancel")
      act(async () => {
        await deps.backgrounds.cancel(parts[1]!);
        deps.notify("Cancellation requested; the host still owns the run until it closes.", "info");
      });
    else {
      deps.notify(
        "Usage: /background | /background list | /background cancel <execution-id>",
        "warn",
      );
      return "block";
    }
    return true;
  };
  commands.registerAction({
    name: "background.open",
    title: "Background runs",
    slash: "/background",
    surface: "slash",
    group: "actions",
    desc: "Keep the current run alive and close the TUI after confirmation",
    subcommands: [
      { name: "list", desc: "View running work and results in this workspace" },
      { name: "cancel", desc: "Request cancellation of an exact hosted execution" },
    ],
    run: () => {
      backgroundRoute("");
    },
    route: backgroundRoute,
  });
  commands.registerAction({
    name: "background.attach",
    title: "Attach to run",
    slash: "/attach",
    surface: "slash",
    group: "navigate",
    desc: "Return to an existing hosted run without resubmitting its prompt",
    args: [{ name: "<execution-id>" }],
    run: () => open(),
    route(args) {
      const id = args.trim();
      if (!id || /\s/.test(id)) {
        deps.notify("Usage: /attach <execution-id>. Use /background list to choose a run.", "warn");
        return "block";
      }
      act(() => deps.backgrounds.attach(id));
      return true;
    },
  });
  return {
    async offer(canOpen) {
      if (!deps.backgrounds.offerOnStartup) return;
      const rows = await deps.backgrounds.list();
      if (!rows.some((ref) => ref.disconnect_policy === "continue")) return;
      if (canOpen()) open(true);
      else
        deps.notify("Background work is available. Use /background list to return to it.", "info");
    },
  };
}
