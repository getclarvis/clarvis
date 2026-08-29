import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { globalPaths, writeFileAtomicSync } from "@clarvis/paths";
import { z } from "zod";
import { readJsonFile } from "@clarvis/loop/host";
import type { SettingsData, WorkspaceTrustVerdict } from "@clarvis/protocol";

/**
 * The workspace-scope settings fields a cloned repository must not be able to
 * supply on its own authority, because each one makes Clarvis execute code or
 * load a third party's configuration.
 *
 * @remarks
 * Workspace settings reach the merge labelled `origin: "operator"`, identically
 * to the operator's own global `settings.json`, so nothing downstream can tell
 * the two apart — a repository's `.clarvis/settings.json` is otherwise as
 * authoritative as the machine owner's. That conflation is only inert while the
 * risky fields are inert; `hooks` stopped being inert when the executor was
 * wired, at which point cloning a repository and opening it became enough to run
 * a shell command.
 *
 * The list is deliberately short, and every entry earns its place by *executing*
 * or by choosing what will execute:
 * - `hooks` spawns a shell command on a lifecycle event.
 * - `mcpServers` spawns a subprocess with a repository-chosen `command`.
 * - `enabledPlugins` turns on a plugin in `builtin:default`, which contributes
 *   both of the above.
 * - `marketplaces` seeds the plugin browser with a repository-chosen git URL.
 *   It executes nothing by itself, so it is the weakest entry here; it is
 *   included because an origin the repository picked should not appear in the
 *   operator's install list wearing the operator's own authority.
 * - `providers.subscription` attempts to attach global subscription credentials
 *   to a repository-chosen provider declaration or endpoint contract.
 *
 * Policy fields a repository might merely weaken (`guard`, `sandbox`) are
 * deliberately absent: keeping the list short is what keeps the verdict `inert`
 * for the overwhelming majority of repositories, and a mechanism that prompts
 * about ordinary repositories teaches the answer "approve" and protects nobody.
 */
export const WORKSPACE_RISK_FIELDS = [
  "hooks",
  "mcpServers",
  "enabledPlugins",
  "marketplaces",
  "memory.provider",
  "plans.provider",
  "tasks.provider",
  "providers.subscription",
] as const;

/** One entry of {@link WORKSPACE_RISK_FIELDS}. */
export type WorkspaceRiskField = (typeof WORKSPACE_RISK_FIELDS)[number];

/**
 * The result of {@link stripWorkspaceRiskFields}: the settings safe to merge,
 * plus the names of whatever was held back.
 */
export interface StrippedWorkspaceSettings {
  /** The workspace settings with every risky field removed. */
  settings: SettingsData;
  /**
   * The risky fields that were present and are being withheld from the merge,
   * in {@link WORKSPACE_RISK_FIELDS} order. Empty when the workspace declared
   * none — the overwhelmingly common case.
   */
  withheld: readonly WorkspaceRiskField[];
}

/**
 * Whether a risky field's value actually declares anything.
 *
 * @param value - the field's value from the workspace settings.
 * @returns `false` for absent, `[]` and `{}`.
 * @remarks An empty `hooks: []` or `mcpServers: {}` is a key with nothing behind
 *   it. Counting it as a declared surface would make an ordinary repository
 *   `unapproved` and prompt the operator to approve nothing at all — precisely
 *   the noise that makes an approval mechanism worthless.
 */
function declaresSomething(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/**
 * Remove the {@link WORKSPACE_RISK_FIELDS} from one scope's settings so they
 * cannot reach the merge.
 *
 * @param settings - the workspace scope's parsed `settings.json`.
 * @returns the settings to merge and the {@link StrippedWorkspaceSettings.withheld |
 *   withheld} field names. The input is never mutated; when nothing is withheld
 *   the original object is returned as-is.
 * @remarks Withholding rather than refusing to start is the deliberate posture:
 *   it preserves the property that makes Clarvis useful — open any repository
 *   and work — while denying that repository the authority to run commands. The
 *   run proceeds on the operator's own configuration, and the caller is expected
 *   to surface `withheld` to the human, never to the model.
 */
export function stripWorkspaceRiskFields(settings: SettingsData): StrippedWorkspaceSettings {
  const executableProvider = (field: "memory" | "plans"): boolean => {
    const block = settings[field];
    if (typeof block !== "object" || block === null) return false;
    const provider = (block as { provider?: { kind?: unknown } }).provider;
    return provider?.kind === "executable" || provider?.kind === "plugin";
  };
  const withheld = WORKSPACE_RISK_FIELDS.filter((field) => {
    if (field === "providers.subscription") return subscriptionProviders(settings).length > 0;
    if (field === "memory.provider") return executableProvider("memory");
    if (field === "plans.provider") return executableProvider("plans");
    if (field === "tasks.provider") {
      const block = settings.tasks;
      return (
        typeof block === "object" &&
        block !== null &&
        typeof (block as { provider?: unknown }).provider === "object"
      );
    }
    return declaresSomething(settings[field]);
  });
  if (withheld.length === 0) return { settings, withheld: [] };
  const kept: SettingsData = { ...settings };
  for (const field of withheld) {
    if (field === "providers.subscription") {
      const providers = nonSubscriptionProviders(kept);
      if (providers?.length) kept.providers = providers;
      else delete kept.providers;
      continue;
    }
    if (field === "tasks.provider") {
      delete kept.tasks;
      continue;
    }
    if (field === "memory.provider" || field === "plans.provider") {
      const blockName = field.startsWith("memory") ? "memory" : "plans";
      const block = kept[blockName];
      if (typeof block === "object" && block !== null) {
        const next = { ...(block as Record<string, unknown>) };
        delete next.provider;
        kept[blockName] = next;
      }
    } else {
      delete kept[field];
    }
  }
  return { settings: kept, withheld };
}

function subscriptionProviders(settings: SettingsData): Array<{ name?: unknown; kind?: unknown }> {
  return Array.isArray(settings.providers)
    ? settings.providers.filter(
        (provider) => provider.kind === "openai-codex" || provider.kind === "xai-grok",
      )
    : [];
}

function nonSubscriptionProviders(settings: SettingsData): SettingsData["providers"] {
  return Array.isArray(settings.providers)
    ? settings.providers.filter(
        (provider) => provider.kind !== "openai-codex" && provider.kind !== "xai-grok",
      )
    : settings.providers;
}

/**
 * Permanently remove subscription-provider declarations and overrides from a workspace.
 * Approval can authorize model selection, but never creates or redirects global credentials.
 */
export function stripWorkspaceSubscriptionProviders(
  settings: SettingsData,
  protectedProviderNames: ReadonlySet<string> = new Set(),
): StrippedWorkspaceSettings {
  if (!Array.isArray(settings.providers)) return { settings, withheld: [] };
  const providers = settings.providers.filter(
    (provider) =>
      provider.kind !== "openai-codex" &&
      provider.kind !== "xai-grok" &&
      !protectedProviderNames.has(provider.name),
  );
  if (providers.length === settings.providers.length) return { settings, withheld: [] };
  return {
    settings:
      providers.length > 0
        ? { ...settings, providers }
        : Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "providers")),
    withheld: ["providers.subscription"],
  };
}

/**
 * The parts of a workspace that can execute code and therefore require
 * approval. A key is present only when that surface is non-empty.
 */
export interface WorkspaceExecutableSurface {
  /** The risky settings fields the workspace declares, by name. */
  settings?: Record<string, unknown>;
  /** Name-sorted digests of the workspace's `.clarvis/agents/*.md`. */
  agents?: WorkspaceAgentSurface[];
  /** Workspace Environment selection/definition surface that activates plugins. */
  extensions?: unknown;
}

interface WorkspaceAgentSurface {
  name: string;
  digest: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const child = record[key];
    if (child !== undefined) out[key] = canonical(child);
  }
  return out;
}

function workspaceAgentSurface(
  files: { name: string; content: string }[],
): WorkspaceAgentSurface[] {
  return files
    .map((file) => ({
      name: file.name,
      digest: `sha256:${createHash("sha256").update(file.content).digest("hex")}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Assemble a workspace's approvable {@link WorkspaceExecutableSurface}.
 *
 * @param settings - the workspace scope's parsed `settings.json`, if any.
 * @param agents - the workspace's agent files as `{ name, content }` pairs.
 * @returns the surface, or `undefined` when the workspace contributes nothing
 *   executable — it is inert and must never be prompted about.
 * @remarks Agent files count because an agent's markdown body becomes a system
 *   prompt section verbatim, so a repository that ships one is choosing what the
 *   model is told it is.
 */
function workspaceExecutableSurface(
  settings: SettingsData | undefined,
  agents: { name: string; content: string }[] = [],
  extensions?: unknown,
): WorkspaceExecutableSurface | undefined {
  const risky: Record<string, unknown> = {};
  for (const field of WORKSPACE_RISK_FIELDS) {
    if (field === "providers.subscription") {
      const providers = subscriptionProviders(settings ?? {});
      if (providers.length > 0) risky[field] = providers;
      continue;
    }
    if (field === "tasks.provider") {
      const block = settings?.tasks;
      const provider =
        typeof block === "object" && block !== null
          ? (block as { provider?: unknown }).provider
          : undefined;
      if (typeof provider === "object" && provider !== null) risky[field] = provider;
      continue;
    }
    if (field === "memory.provider" || field === "plans.provider") {
      const blockName = field.startsWith("memory") ? "memory" : "plans";
      const block = settings?.[blockName];
      const provider =
        typeof block === "object" && block !== null
          ? (block as { provider?: { kind?: unknown } }).provider
          : undefined;
      if (provider?.kind === "executable" || provider?.kind === "plugin") risky[field] = provider;
    } else {
      const value = settings?.[field];
      if (declaresSomething(value)) risky[field] = value;
    }
  }
  const hasSettings = Object.keys(risky).length > 0;
  const hasAgents = agents.length > 0;
  const hasExtensions = extensions !== undefined;
  if (!hasSettings && !hasAgents && !hasExtensions) return undefined;
  return {
    ...(hasSettings ? { settings: risky } : {}),
    ...(hasAgents ? { agents: workspaceAgentSurface(agents) } : {}),
    ...(hasExtensions ? { extensions } : {}),
  };
}

/**
 * Compute the stable `sha256:<hex>` fingerprint of a workspace's executable
 * surface, the value approvals are recorded and compared against.
 *
 * @param settings - the workspace scope's parsed `settings.json`, if any.
 * @param agents - the workspace's agent files.
 * @returns the fingerprint, or `undefined` for an inert workspace.
 */
export function workspaceTrustFingerprint(
  settings: SettingsData | undefined,
  agents: { name: string; content: string }[] = [],
  extensions?: unknown,
): string | undefined {
  const surface = workspaceExecutableSurface(settings, agents, extensions);
  if (surface === undefined) return undefined;
  const json = JSON.stringify(canonical(surface));
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

/** One approved workspace surface: its `fingerprint` and approval timestamp. */
const workspaceTrustEntrySchema = z
  .object({
    fingerprint: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/, "fingerprint must be 'sha256:<64 hex chars>'"),
    approved_at: z.string().min(1),
  })
  .strict();

/**
 * The `workspace-trust.json` schema: a map from canonical workspace path to the
 * surfaces approved for it.
 */
export const workspaceTrustSchema = z
  .object({
    workspaces: z.record(z.string().min(1), z.array(workspaceTrustEntrySchema).min(1)),
  })
  .strict();

/** The inferred type of a parsed workspace trust store. */
export type WorkspaceTrust = z.infer<typeof workspaceTrustSchema>;

/** The outcome of {@link readWorkspaceTrustFile}. */
export interface WorkspaceTrustFileResult {
  /** The parsed store on success (empty when the file was absent). */
  trust?: WorkspaceTrust;
  /** Human-readable error when the file existed but could not be read. */
  error?: string;
}

/**
 * Canonicalize a workspace path for use as a trust key.
 *
 * @param workspaceRoot - the workspace root as given.
 * @returns the real path, or the input when it cannot be resolved.
 * @remarks Resolving symlinks matters: without it, approving `/home/me/project`
 *   would leave `/tmp/link-to-project` unapproved (merely annoying) and, worse,
 *   a new symlink to an approved directory would carry the approval to whatever
 *   it is later repointed at.
 */
export function canonicalWorkspaceKey(workspaceRoot: string): string {
  try {
    return realpathSync(workspaceRoot);
  } catch {
    return workspaceRoot;
  }
}

/**
 * Read `workspace-trust.json` from a global config dir.
 *
 * @param globalDir - the Clarvis global config directory.
 * @returns the parsed store, or a diagnostic. A missing file is success with an
 *   empty store; an unreadable one is an error, and callers must treat it as
 *   "nothing approved" rather than "everything approved".
 */
export function readWorkspaceTrustFile(globalDir: string): WorkspaceTrustFileResult {
  const path = globalPaths(globalDir).workspaceTrustFile;
  const res = readJsonFile(path, workspaceTrustSchema);
  if (res.ok) return { trust: res.value };
  if (res.missing === true) return { trust: { workspaces: {} } };
  return { error: res.error };
}

/**
 * Classify a workspace's trust state against a trust store.
 *
 * @param fingerprint - the workspace's current fingerprint, or `undefined` when inert.
 * @param key - the canonical workspace path.
 * @param trust - the parsed store, or `undefined` to treat as empty.
 * @returns the workspace trust verdict; `changed` reports the most recently
 *   approved fingerprint.
 */
export function workspaceTrustVerdict(
  fingerprint: string | undefined,
  key: string,
  trust: WorkspaceTrust | undefined,
): WorkspaceTrustVerdict {
  if (fingerprint === undefined) return { state: "inert" };
  const entries = trust?.workspaces[key];
  const latest = entries === undefined ? undefined : entries[entries.length - 1];
  if (latest === undefined) return { state: "unapproved", fingerprint };
  if (entries?.some((e) => e.fingerprint === fingerprint) === true) {
    return { state: "trusted", fingerprint };
  }
  return { state: "changed", fingerprint, approved: latest.fingerprint };
}

/**
 * Record or remove an approval for a workspace, rewriting the store atomically.
 *
 * @param globalDir - the Clarvis global config directory.
 * @param key - the canonical workspace path.
 * @param fingerprint - the surface to approve, or `undefined` to revoke every
 *   approval for this workspace.
 * @param now - ISO timestamp recorded with an approval; injectable for tests.
 * @throws {@link Error} when the existing store cannot be parsed — overwriting it
 *   would silently drop approvals the operator made.
 */
export function writeWorkspaceTrust(
  globalDir: string,
  key: string,
  fingerprint: string | undefined,
  now: () => string = () => new Date().toISOString(),
): void {
  const current = readWorkspaceTrustFile(globalDir);
  if (current.trust === undefined) {
    throw new Error(`workspace-trust.json is unreadable, refusing to overwrite: ${current.error}`);
  }
  const workspaces = { ...current.trust.workspaces };
  if (fingerprint === undefined) {
    delete workspaces[key];
  } else {
    const existing = workspaces[key] ?? [];
    workspaces[key] = existing.some((e) => e.fingerprint === fingerprint)
      ? existing
      : [...existing, { fingerprint, approved_at: now() }];
  }
  const path = globalPaths(globalDir).workspaceTrustFile;
  writeFileAtomicSync(path, JSON.stringify({ workspaces }, null, 2));
}
