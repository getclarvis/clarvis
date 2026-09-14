import type { EnvConfig, ModelExecutionInfo } from "@clarvis/capability";
import { globalPaths, workspacePaths } from "@clarvis/paths";
import { loadMemoryPolicy } from "@clarvis/memory/capability";
import { providerConfigSchema } from "@clarvis/loop/host";
import { loadWorkflows } from "@clarvis/workflows/artifact";
import { BUILTIN_WORKFLOWS } from "@clarvis/workflows";
import type { ModelCatalogService } from "@clarvis/protocol";
import type { ConfigStore } from "./config-store.ts";
import {
  projectContainerConfiguration,
  type ContainerConfiguration,
} from "./container-projection.ts";
import { resolveStoreSharedPrompt, stampedSharedPrompt } from "./shared-prompt.ts";

/** Resolve logical model metadata while dropping every endpoint, header and credential field. */
async function logicalModels(
  store: ConfigStore,
  catalogService: ModelCatalogService,
  env: EnvConfig,
): Promise<ModelExecutionInfo[]> {
  const settings = store.readSettings().operator_merged;
  if (settings === undefined) throw new Error("Container projection requires operator settings");
  const catalog = await catalogService.get();
  const output: ModelExecutionInfo[] = [];
  const seen = new Set<string>();
  const providers = providerConfigSchema.array().parse(settings.providers ?? []);
  for (const provider of providers) {
    const catalogProvider = catalog.providers.find(
      (candidate) => candidate.id === provider.name || candidate.kind === provider.kind,
    );
    const kind = provider.kind;
    const configured = provider.models ?? {};
    const models =
      Object.keys(configured).length > 0
        ? Object.entries(configured).map(([id, model]) => ({ id, ...model }))
        : (catalogProvider?.models ?? []);
    for (const model of models) {
      const key = JSON.stringify([provider.name, model.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      const catalogModel = catalogProvider?.models.find((candidate) => candidate.id === model.id);
      output.push({
        provider: provider.name,
        model: model.id,
        kind,
        contextWindowTokens:
          "context_window_tokens" in model
            ? model.context_window_tokens
            : (catalogModel?.context_window ?? env.CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS),
        capabilities: "capabilities" in model ? model.capabilities : catalogModel?.capabilities,
        reasoningEfforts:
          "reasoning_efforts" in model ? model.reasoning_efforts : catalogModel?.reasoning_efforts,
        promptCache: "prompt_cache" in model ? model.prompt_cache : undefined,
        ...("max_output_tokens" in model && model.max_output_tokens !== undefined
          ? { maxOutputTokens: model.max_output_tokens }
          : catalogModel?.max_output === undefined
            ? {}
            : { maxOutputTokens: catalogModel.max_output }),
      });
    }
  }
  return output;
}

/** Snapshot all operator-owned execution data once for one Container generation. */
export async function projectContainerHostConfiguration(options: {
  readonly store: ConfigStore;
  readonly models: ModelCatalogService;
  readonly env: EnvConfig;
  readonly workspaceRoot: string;
  readonly globalDir: string;
  readonly defaultAgent?: string;
}): Promise<ContainerConfiguration> {
  const globalWorkflows = loadWorkflows([globalPaths(options.globalDir).workflowsDir]);
  const workspaceWorkflows = loadWorkflows([workspacePaths(options.workspaceRoot).workflowsDir]);
  if (globalWorkflows.errors.length > 0 || workspaceWorkflows.errors.length > 0)
    throw new Error("Container workflow projection contains unreadable definitions");
  const contexts = (["global", "workspace"] as const).flatMap((scope) => {
    const context = options.store.readContext(scope);
    return context === null ? [] : [{ scope, content: context.content }];
  });
  return projectContainerConfiguration({
    store: options.store,
    env: options.env,
    modelCatalog: await logicalModels(options.store, options.models, options.env),
    sharedPrompt: stampedSharedPrompt(resolveStoreSharedPrompt(options.store)),
    contexts,
    memoryPolicy:
      loadMemoryPolicy({
        global: globalPaths(options.globalDir).memoryPolicyFile,
        workspace: workspacePaths(options.workspaceRoot).memoryPolicyFile,
      }) ?? "",
    workflowDefinitions: [
      ...BUILTIN_WORKFLOWS.map((definition) => ({ origin: "builtin" as const, definition })),
      ...globalWorkflows.workflows.map((definition) => ({ origin: "global" as const, definition })),
      ...workspaceWorkflows.workflows.map((definition) => ({
        origin: "workspace" as const,
        definition,
      })),
    ],
    ...(options.defaultAgent === undefined ? {} : { defaultAgent: options.defaultAgent }),
  });
}
