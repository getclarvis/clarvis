import type { CommandScope, ViewHost } from "#src/keys/commands.ts";
import type { SettingsAdapter } from "#src/adapters/settings.ts";
import type { CodeConfigStore } from "#src/adapters/code-config.ts";
import type { EnvView } from "#src/adapters/agent-files.ts";
import type { AgentsStore } from "#src/adapters/agents-store.ts";
import type { HintTone } from "#src/views/hint.ts";
import type { ModelsCatalog } from "#src/adapters/models-catalog.ts";
import { detachObserved } from "#src/core/tasks.ts";
import { lazyView } from "#src/views/config/lazy-view.tsx";

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
    const { AgentsPanel } = await import("#src/views/cold-surfaces.ts");
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
