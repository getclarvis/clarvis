import type { ConfigChange, Scope, SettingsData, SettingsSource } from "@clarvis/protocol";
import {
  SettingsRevisionConflictError,
  settingsDocumentRevision,
  type AgentInput,
  type AgentRecord,
  type ConfigStore,
  type SettingsSnapshot,
  type SharedPromptFile,
} from "./config-store.ts";
import { builtinAgentRecord, resolveEffectiveAgent } from "./agent-overlay.ts";
import { BUILTIN_AGENT_NAMES, isBuiltinAgent, readBuiltinAgent } from "./builtin-agents/index.ts";

/** Optional initial state for {@link createMemoryConfigStore}. */
export interface MemoryConfigSeed {
  /** Per-scope settings the store starts with. */
  settings?: Partial<Record<Scope, SettingsData>>;
  /** Agents to preload, keyed internally by `scope/name`. */
  agents?: AgentRecord[];
  /** Per-scope context markdown to preload. */
  context?: Partial<Record<Scope, string>>;
  /** Per-scope shared-agent prompt documents to preload. */
  sharedPrompts?: Partial<Record<Scope, string>>;
}

const SCOPES: readonly Scope[] = ["global", "workspace"];

/**
 * Build an in-memory {@link ConfigStore} for tests and ephemeral kernels.
 *
 * @param seed - optional initial settings, agents, and context; see
 *   {@link MemoryConfigSeed}.
 * @returns a {@link ConfigStore} that keeps all state in process. Its
 *   {@link ConfigStore.watch | watch} always fires on `writeSettings`,
 *   `writeAgent`, and `deleteAgent`, and `readContext` records carry no `path`.
 * @remarks The merged snapshot is a shallow `global` then `workspace` overlay —
 *   there is no plugin layer here, unlike {@link createFileConfigStore}. Unlike
 *   the service, this store performs no validation.
 *
 *   The agents Clarvis ships **are** present, resolved against any seeded record
 *   of the same name exactly as the file store resolves them against a file. A
 *   test store without them would disagree with every real host about what an
 *   empty configuration contains, which is the one thing this store exists to
 *   stand in for.
 */
export function createMemoryConfigStore(seed?: MemoryConfigSeed): ConfigStore {
  const settings: Partial<Record<Scope, SettingsData>> = { ...(seed?.settings ?? {}) };
  const agents = new Map<string, AgentRecord>();
  for (const a of seed?.agents ?? []) agents.set(`${a.scope}/${a.name}`, a);
  const context: Partial<Record<Scope, string>> = { ...(seed?.context ?? {}) };
  const sharedPrompts: Partial<Record<Scope, string>> = { ...(seed?.sharedPrompts ?? {}) };
  const listeners = new Set<(c: ConfigChange) => void>();

  const emit = (kind: ConfigChange["kind"], scope: Scope): void => {
    const change: ConfigChange = { kind, scope, at: Date.now() };
    for (const l of listeners) l(change);
  };

  /** Recompute the snapshot: a shallow `global` then `workspace` merge plus `memory:`-prefixed sources. */
  const snapshot = (): SettingsSnapshot => {
    const merged: SettingsData = { ...(settings.global ?? {}), ...(settings.workspace ?? {}) };
    const mcpServerOrigins = Object.fromEntries(
      Object.keys(merged.mcpServers ?? {}).map((name) => [name, "operator" as const]),
    );
    const sources: SettingsSource[] = SCOPES.map((scope) => ({
      scope,
      path: `memory:${scope}`,
      exists: settings[scope] !== undefined,
      revision:
        settings[scope] === undefined
          ? null
          : settingsDocumentRevision(JSON.stringify(settings[scope])),
    }));
    return { merged, scopes: { ...settings }, sources, mcpServerOrigins };
  };

  /** Build an {@link AgentRecord}, lifting `model`/`description` out of the frontmatter when typed as strings. */
  const toRecord = (scope: Scope, name: string, input: AgentInput): AgentRecord => {
    const fm = input.frontmatter;
    return {
      name,
      scope,
      frontmatter: fm,
      body: input.body,
      ...(typeof fm.model === "string" ? { model: fm.model } : {}),
      ...(typeof fm.description === "string" ? { description: fm.description } : {}),
    };
  };

  return {
    readSettings: () => snapshot(),
    readSettingsDocument: (scope) => {
      const current = settings[scope];
      if (current === undefined) return null;
      const raw = JSON.stringify(current);
      return { raw, revision: settingsDocumentRevision(raw) };
    },
    compareAndSwapSettingsDocument: (scope, expectedRevision, repair) => {
      const current = settings[scope];
      const raw = current === undefined ? null : JSON.stringify(current);
      const actualRevision = raw === null ? null : settingsDocumentRevision(raw);
      if (raw === null || actualRevision !== expectedRevision) {
        throw new SettingsRevisionConflictError(expectedRevision, actualRevision);
      }
      settings[scope] = repair(raw);
      emit("settings", scope);
      return snapshot();
    },
    writeSettings: (scope, data) => {
      settings[scope] = data;
      emit("settings", scope);
      return snapshot();
    },
    mutateSettings: (scope, expectedRevision, mutate) => {
      const current = settings[scope];
      const actualRevision =
        current === undefined ? null : settingsDocumentRevision(JSON.stringify(current));
      if (actualRevision !== expectedRevision) {
        throw new SettingsRevisionConflictError(expectedRevision, actualRevision);
      }
      settings[scope] = mutate(current ?? {});
      emit("settings", scope);
      return snapshot();
    },
    listAgents: () => {
      const seeded = [...agents.values()];
      const byScope = (scope: Scope, name: string): AgentRecord | null =>
        agents.get(`${scope}/${name}`) ?? null;
      return [
        ...BUILTIN_AGENT_NAMES.map((name) =>
          resolveEffectiveAgent(name, {
            workspace: byScope("workspace", name),
            global: byScope("global", name),
          })!,
        ),
        ...seeded.filter((a) => !isBuiltinAgent(a.name)),
      ];
    },
    readAgent: (scope, name) => {
      if (scope === "builtin") {
        const builtin = readBuiltinAgent(name);
        return builtin === undefined ? null : builtinAgentRecord(builtin);
      }
      return agents.get(`${scope}/${name}`) ?? null;
    },
    readEffectiveAgent: (name) =>
      resolveEffectiveAgent(name, {
        workspace: agents.get(`workspace/${name}`) ?? null,
        global: agents.get(`global/${name}`) ?? null,
      }),
    writeAgent: (scope, name, input) => {
      const record = toRecord(scope, name, input);
      agents.set(`${scope}/${name}`, record);
      emit("agents", scope);
      return record;
    },
    deleteAgent: (scope, name) => {
      agents.delete(`${scope}/${name}`);
      emit("agents", scope);
    },
    readSharedPrompt: (scope): SharedPromptFile => ({
      path: `memory:${scope}/shared-agent.md`,
      ...(sharedPrompts[scope] !== undefined ? { raw: sharedPrompts[scope] } : {}),
    }),
    writeSharedPrompt: (scope, content) => {
      sharedPrompts[scope] = content;
      emit("agents", scope);
      return { path: `memory:${scope}/shared-agent.md`, raw: content };
    },
    deleteSharedPrompt: (scope) => {
      delete sharedPrompts[scope];
      emit("agents", scope);
    },
    readContext: (scope) =>
      context[scope] !== undefined ? { scope, content: context[scope] } : null,
    watch: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
