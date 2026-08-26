import type { CommandScope, ViewHost } from "../../keys/commands.ts";
import type { SettingsAdapter } from "../../adapters/settings.ts";
import type { KeysAdapter } from "../../adapters/provider-secrets.ts";
import type { CodeConfigStore } from "../../adapters/code-config.ts";
import type { ModelsCatalog } from "../../adapters/models-catalog.ts";
import type { ModelCatalogService, ProviderAuthService } from "@clarvis/protocol";
import type { HintTone } from "../../views/hint.ts";
import { lazyView } from "../../views/config/lazy-view.tsx";

/** Dependencies {@link registerProvidersCommands} wires into the Providers view. */
export interface ProvidersCommandDeps {
  settings: SettingsAdapter;
  keys: KeysAdapter;
  code: CodeConfigStore;
  catalog: ModelsCatalog | null;
  loadCatalog?: () => Promise<void>;
  modelsService?: ModelCatalogService;
  providerAuth?: ProviderAuthService;
  notify: (message: string, tone?: HintTone) => void;
  copyText?: (text: string) => Promise<boolean>;
  openUrl?: (url: string) => Promise<boolean>;
}

/** Registers the Providers settings view on the shared command registry. */
export function registerProvidersCommands(
  commands: CommandScope,
  deps: ProvidersCommandDeps,
): void {
  const view = lazyView(async () => {
    const [{ ProvidersPanel }] = await Promise.all([
      import("../../views/config/ProvidersPanel.tsx"),
      deps.loadCatalog?.() ?? Promise.resolve(),
    ]);
    return (host: ViewHost) => {
      return ProvidersPanel(host, {
        settings: deps.settings,
        catalog: deps.catalog,
        ...(deps.modelsService === undefined ? {} : { modelsService: deps.modelsService }),
        ...(deps.providerAuth === undefined ? {} : { providerAuth: deps.providerAuth }),
        ...(deps.copyText === undefined ? {} : { copyText: deps.copyText }),
        ...(deps.openUrl === undefined ? {} : { openUrl: deps.openUrl }),
        keys: deps.keys,
        code: deps.code,
        notify: deps.notify,
        bootstrap: (deps.settings.effective().providers?.length ?? 0) === 0,
      });
    };
  });
  commands.registerView({
    name: "providers.open",
    title: "Providers",
    desc: "Edit provider credentials, models and context limits",
    slash: false,
    surface: "internal",
    group: "navigate",
    parent: "settings",
    view,
  });
}
