import type { AgentsStore } from "../adapters/agents-store.ts";
import type { EnvView } from "../adapters/agent-files.ts";
import type { CodeConfigStore } from "../adapters/code-config.ts";
import type { KeysAdapter } from "../adapters/provider-secrets.ts";
import type { ModelsCatalog } from "../adapters/models-catalog.ts";
import type { ModelCatalogService, ProviderAuthService } from "@clarvis/protocol";
import type { SettingsAdapter } from "../adapters/settings.ts";
import type { HintTone } from "../views/hint.ts";
import { registerAppCommands, type AppCommandDeps, type AppCommandWiring } from "./commands.tsx";
import { registerAgentsCommands } from "../features/agents/commands.ts";
import { registerProvidersCommands } from "../features/providers/commands.ts";
import { registerLoopCommands } from "../features/loop/commands.ts";
import type { LoopController } from "../features/loop/controller.ts";

/** Feature dependencies consumed by the application command composition root. */
export interface FeatureCommandDeps {
  settings: SettingsAdapter;
  catalog: ModelsCatalog | null;
  loadCatalog?: () => Promise<void>;
  modelsService?: ModelCatalogService;
  providerAuth?: ProviderAuthService;
  keys: KeysAdapter;
  code: CodeConfigStore;
  agents: AgentsStore;
  env: EnvView;
  notify: (message: string, tone?: HintTone) => void;
  copyText?: (text: string) => Promise<boolean>;
  openUrl?: (url: string) => Promise<boolean>;
}

/** Dependencies for composing application and feature registrations. */
export interface CodeCommandDeps extends AppCommandDeps {
  features: FeatureCommandDeps;
  loops?: LoopController;
}

/**
 * Registers every command contributor against the single searchable registry.
 *
 * @param deps - Application and feature command dependencies.
 * @returns The application command projections used by the shell.
 */
export function registerCodeCommands(deps: CodeCommandDeps): AppCommandWiring {
  const { commands, features } = deps;
  const featureScope = commands.scope();
  if (deps.loops)
    registerLoopCommands(featureScope, { loops: deps.loops, ui: deps.ui, notify: deps.notify });
  registerProvidersCommands(featureScope, {
    settings: features.settings,
    catalog: features.catalog,
    ...(features.loadCatalog === undefined ? {} : { loadCatalog: features.loadCatalog }),
    ...(features.modelsService === undefined ? {} : { modelsService: features.modelsService }),
    ...(features.providerAuth === undefined ? {} : { providerAuth: features.providerAuth }),
    ...(features.copyText === undefined ? {} : { copyText: features.copyText }),
    ...(features.openUrl === undefined ? {} : { openUrl: features.openUrl }),
    keys: features.keys,
    code: features.code,
    notify: features.notify,
  });
  registerAgentsCommands(featureScope, {
    agents: features.agents,
    settings: features.settings,
    catalog: features.catalog,
    ...(features.loadCatalog === undefined ? {} : { loadCatalog: features.loadCatalog }),
    code: features.code,
    env: features.env,
    notify: features.notify,
  });
  const app = registerAppCommands(deps);
  let disposed = false;
  return {
    ...app,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      app.dispose();
      featureScope.dispose();
    },
  };
}
