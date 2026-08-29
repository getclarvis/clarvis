import type { CommandScope, ViewHost } from "../../keys/commands.ts";
import type { SettingsAdapter } from "../../adapters/settings.ts";
import type { CodeConfigStore } from "../../adapters/code-config.ts";
import type { EnvView } from "../../adapters/agent-files.ts";
import type { AgentsStore } from "../../adapters/agents-store.ts";
import type { HintTone } from "../../views/hint.ts";
import type { ModelsCatalog } from "../../adapters/models-catalog.ts";
import { detachObserved } from "../../core/tasks.ts";
import { lazyView } from "../../views/config/lazy-view.tsx";

/** Dependencies for registering the Agents settings view. */
export interface AgentsCommandDeps {
  agents: AgentsStore;
  settings: SettingsAdapter;
  catalog: ModelsCatalog | null;
  loadCatalog?: () => Promise<void>;
  code: CodeConfigStore;
  env: EnvView;
  notify: (message: string, tone?: HintTone) => void;
}

/** Registers the Agents settings view on the shared command registry. */
export function registerAgentsCommands(commands: CommandScope, deps: AgentsCommandDeps): void {
  const view = lazyView(async () => {
    const { AgentsPanel } = await import("../../views/cold-surfaces.ts");
    return (host: ViewHost) => {
      if (deps.loadCatalog !== undefined) detachObserved("models_catalog_load", deps.loadCatalog);
      return AgentsPanel(host, {
        agents: deps.agents,
        settings: deps.settings,
        catalog: deps.catalog,
        code: deps.code,
        env: deps.env,
        notify: deps.notify,
      });
    };
  });
  commands.registerView({
    name: "agents.open",
    title: "Agents",
    desc: "Author agents: grants, model, spawn graph, prompt",
    surface: "internal",
    group: "navigate",
    parent: "settings",
    view,
  });
}
