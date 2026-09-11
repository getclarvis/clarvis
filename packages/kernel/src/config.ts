/** Configuration, catalogs, schemas, and settings composition. */
export { parseAgentFrontmatter } from "./config/frontmatter.ts";
export { createConfigService } from "./config/config-service.ts";
export { createMemoryConfigStore } from "./config/memory-config-store.ts";
export type { MemoryConfigSeed } from "./config/memory-config-store.ts";
export { createFileConfigStore } from "./config/file-config-store.ts";
export type { FileConfigStoreOptions } from "./config/file-config-store.ts";
export { kernelSettingsSchema } from "./config/capability-registry.ts";
export type { KernelSettingsFile as SettingsFile } from "./config/capability-registry.ts";
export { WORKSPACE_RISK_FIELDS, stripWorkspaceRiskFields } from "./config/workspace-trust.ts";
export type { StrippedWorkspaceSettings, WorkspaceRiskField } from "./config/workspace-trust.ts";
export type {
  ConfigStore,
  SettingsSnapshot,
  AgentOverlay,
  AgentRecord,
  AgentInput,
  ContextRecord,
  SharedPromptFile,
} from "./config/config-store.ts";
export { compareAgentDisplayOrder, resolveAgentsByName } from "./config/agent-resolution.ts";
export { DEFAULT_SHARED_AGENT_PROMPT, renderSharedPromptDocument } from "@clarvis/loop/host";
export {
  BUILTIN_AGENTS,
  BUILTIN_AGENT_NAMES,
  DEFAULT_ENTRY_AGENT,
  isBuiltinAgent,
  readBuiltinAgent,
} from "./config/builtin-agents/index.ts";
export type { BuiltinAgent } from "./config/builtin-agents/index.ts";
export { resolveEffectiveAgent, builtinAgentRecord } from "./config/agent-overlay.ts";
export type { AgentOverlayLayers } from "./config/agent-overlay.ts";
export {
  PROVIDER_KINDS,
  createModelsCatalog,
  createModelCatalogService,
  resolveModelPrice,
  cacheModeOf,
  derivePromptCacheMode,
  loadCatalogData,
  writeCatalogCache,
  fetchModelsDevApi,
  projectModelsDevApi,
  refreshModelsCatalog,
} from "./models/model-catalog.ts";
export type {
  ProviderConfig,
  ProviderKind,
  CatalogData,
  CatalogProviderData,
  CatalogModelData,
  CatalogCost,
  CatalogModel,
  CatalogProvider,
  ModelsCatalog,
} from "./models/model-catalog.ts";
export { PLANS_DEFAULTS } from "@clarvis/plan/settings";
export type { PlansSettingsBlock } from "@clarvis/plan/settings";
export { parseModelRef } from "@clarvis/capability";
export {
  readJsonFile,
  parsePluginManifest,
  readPluginAgentFiles,
  PLUGIN_RESOURCE_LIMITS,
  readBoundedPluginText,
  marketplaceSchema,
  mcpServerSettingsSchema,
  boundPromise,
  isWellFormedHttpUrl,
  mergeProviders,
  mergeSettings,
  agentFrontmatterSchema,
  grantSchema,
  profileReadinessIssues,
  type PluginManifest,
  type PluginAgentFile,
  type PluginAgentFilesResult,
  type Marketplace,
  type MarketplaceEntry,
  type MCPStatus,
  type ToolTransport,
  type SettingsScope,
  type providerConfigSchema,
  type AgentFrontmatter,
  type ReadinessIssue,
} from "@clarvis/loop/host";
export {
  DISCOVERY_SCHEMA,
  FINDINGS_SCHEMA,
  VERDICT_SCHEMA,
  WORKFLOW_RESULT_SCHEMAS,
} from "@clarvis/workflows";
export type { WorkflowResultSchema } from "@clarvis/workflows";
