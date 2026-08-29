/**
 * Supported host-composition surface for config, provider, plugin, and sandbox policy.
 *
 * @remarks Kernel and other hosts use this narrow subpath for host policy.
 * Runtime execution remains on the package root and capability-specific
 * subpaths; no general internal barrel is exported.
 */
export {
  agentFrontmatterSchema,
  agentPromptOf,
  normalizeTools,
  splitAgentFrontmatter,
  type AgentFrontmatter,
} from "./settings/agent-frontmatter.ts";
export {
  marketplaceSchema,
  type Marketplace,
  type MarketplaceEntry,
} from "./settings/marketplace-schema.ts";
export {
  parsePluginManifest,
  readPluginAgentFiles,
  type PluginAgentFile,
  type PluginAgentFilesResult,
} from "./settings/plugin-agents.ts";
export {
  PLUGIN_RESOURCE_LIMITS,
  readBoundedPluginText,
  type BoundedPluginTextResult,
} from "./settings/plugin-resources.ts";
export {
  pluginSettingsFragment,
  suspectedManifestTypos,
  unknownManifestKeys,
  type PluginManifest,
  type SuspectedManifestTypo,
} from "./settings/plugin-schema.ts";
export { mergeProviders, mergeSettings, type SettingsScope } from "./settings/settings-merge.ts";
export { readCapabilitySettings, settingsSchemaFor } from "./settings/capability-settings.ts";
export {
  mcpServerSettingsSchema,
  mcpServerPluginSchema,
  pluginNameField,
  pluginRefField,
  settingsSchema,
  type McpServerSettings,
  type SettingsFile,
} from "./settings/settings-schema.ts";
export { settingsServerToEngine } from "./settings/engine-server.ts";
export { defaultGuardMode, type GuardConfig } from "./runtime/capabilities/tools-settings.ts";
export type {
  ResolvedSandboxSettings,
  SandboxSettings,
} from "./runtime/capabilities/tools-settings.ts";
export { parseModelRef } from "@clarvis/capability";
export { resolveProvider } from "@clarvis/capability";
export { providerConfigSchema, grantSchema } from "./validation/request-schema.ts";
export { BUILTIN_GRANT_NAMES } from "./validation/request/grant-registry.ts";
export {
  profileReadinessIssues,
  type ReadinessIssue,
  type ReadinessProfile,
} from "./validation/profile-readiness.ts";
export { deriveEventSpan, type EventSpan } from "@clarvis/trace";
export { CONTROL_PLANE_TOOL_NAMES, SUBMIT_RESULT_TOOL_NAME } from "./runtime/tools/wire-names.ts";
export { boundPromise } from "./runtime/support/bounded.ts";
export { contentToText } from "@clarvis/capability";
export { errorText } from "./error-text.ts";
export { isWellFormedHttpUrl } from "./http-url.ts";
export {
  readJsonFile,
  type ReadJsonFileFailureKind,
  type ReadJsonFileResult,
} from "./json-file.ts";
export { ownerFromWorkspace } from "./workspace.ts";
export { loadEnv } from "@clarvis/capability";
export {
  createExtensionAdmissionController,
  ExtensionCallUnavailableError,
} from "@clarvis/capability";
export type {
  ExtensionAdmissionController,
  ExtensionAdmissionOptions,
  ExtensionAdmissionSnapshot,
} from "@clarvis/capability";
export type { MCPStatus, NamespacedTool } from "@clarvis/capability";
export type { ToolTransport } from "@clarvis/capability";
export {
  buildExecuteRunDeps,
  createHostExtensionAdmission,
  createHostModelCallAdmission,
  hooksEffective,
  type BuildRunDepsOptions,
  type BuiltRunDeps,
  type HostExtensionAdmission,
  type HostModelCallAdmission,
  type SkillRootInput,
} from "./runtime/build-run-deps.ts";
export type { PluginBootstrapSkill } from "./runtime/capabilities/skills-settings.ts";
export { createLogger, type CreateLoggerOptions, type Logger } from "./logger.ts";
export { VERSION } from "./version.ts";
