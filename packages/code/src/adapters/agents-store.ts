import { createSignal, type Accessor } from "solid-js";
import type {
  AgentSummary,
  ConfigService,
  Scope,
  SharedPromptView,
  SharedPromptWrite,
} from "@clarvis/protocol";
import { compareAgentDisplayOrder, resolveAgentsByName } from "@clarvis/kernel/config";
import {
  docToAgentFile,
  normalizeAgentWrite,
  type AgentFile,
  type StoredAgentFile,
} from "./agent-files.ts";
import { hasKernelErrorCode } from "./kernel-errors.ts";

export interface AgentsStore {
  /**
   * Merged agent files (workspace over global over the shipped fleet), in
   * presentation order — reactive.
   */
  list: Accessor<AgentFile[]>;
  /** Names present in both `global` and `workspace` — a legacy cross-scope conflict. */
  conflicts: Accessor<string[]>;
  /**
   * The agent as stored in one layer, or null if absent there. Pass `"builtin"`
   * for the agent as Clarvis ships it, ignoring any file overlaying it.
   */
  read(name: string, scope: Scope | "builtin"): Promise<AgentFile | null>;
  write(file: StoredAgentFile): Promise<void>;
  remove(name: string, scope: Scope): Promise<void>;
  /** Rename an agent within its scope; rejects if the new name collides in either scope. */
  rename(oldName: string, newName: string, scope: Scope): Promise<void>;
  reload(): Promise<void>;
  /** Effective shared prompt and the two editable layers. */
  sharedPrompt(): Promise<SharedPromptView>;
  writeSharedPrompt(scope: Scope, doc: SharedPromptWrite): Promise<SharedPromptView>;
  deleteSharedPrompt(scope: Scope): Promise<void>;
}

/**
 * Names present in more than one config scope among `summaries`.
 *
 * @remarks A shipped agent appears once however many scopes overlay it — the
 *   kernel resolves it before it gets here — so its duplicate arrives on
 *   `overlay.shadowed` rather than as a second row, and has to be read from
 *   there or a conflict on a shipped name would go unreported.
 */
export function findAgentConflicts(summaries: readonly AgentSummary[]): string[] {
  const byName = new Map<string, Set<Scope>>();
  for (const s of summaries) {
    if (s.scope === "plugin") continue;
    const set = byName.get(s.name) ?? new Set<Scope>();
    if (s.scope !== "builtin") set.add(s.scope);
    for (const shadowed of s.overlay?.shadowed ?? []) set.add(shadowed);
    byName.set(s.name, set);
  }
  return [...byName.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([name]) => name)
    .sort();
}

async function resolveAgentFiles(
  config: ConfigService,
  summaries: readonly AgentSummary[],
): Promise<AgentFile[]> {
  const winners = resolveAgentsByName(
    summaries.filter((s): s is AgentSummary & { scope: Scope | "builtin" } => s.scope !== "plugin"),
  );
  const files: AgentFile[] = [];
  for (const summary of winners) {
    const doc = await config.getAgent(summary.scope, summary.name);
    files.push(docToAgentFile(doc, summary.overlay));
  }
  return files.sort(compareAgentDisplayOrder);
}

/** Fetches and merges the scope-resolved agent list, without conflict info. */
export async function loadAgentFiles(config: ConfigService): Promise<AgentFile[]> {
  return resolveAgentFiles(config, await config.listAgents());
}

/** The merged agent list plus any cross-scope conflict, fetched from one `listAgents()` call. */
export interface AgentFilesSnapshot {
  files: AgentFile[];
  conflicts: string[];
}

/**
 * Fetch {@link loadAgentFiles}'s merged list and {@link findAgentConflicts}'s
 * conflict names together, off a single `listAgents()` round trip — use this
 * (not `loadAgentFiles` alone) wherever the result seeds a reactive
 * {@link AgentsStore}, so a pre-existing cross-scope conflict is visible from
 * the first render instead of only after the next `reload()`.
 */
export async function loadAgentFilesSnapshot(
  config: ConfigService,
  prefetched?: Awaited<ReturnType<ConfigService["listAgents"]>>,
): Promise<AgentFilesSnapshot> {
  const summaries = prefetched ?? (await config.listAgents());
  return {
    files: await resolveAgentFiles(config, summaries),
    conflicts: findAgentConflicts(summaries),
  };
}

/**
 * Builds a reactive {@link AgentsStore} seeded with `initial`/`initialConflicts`
 * (typically from {@link loadAgentFilesSnapshot}); every mutation reloads the
 * merged list from `config`.
 *
 * @remarks
 * `reload` guards against out-of-order responses with an epoch counter: if a
 * newer `reload()` starts before an older one's `listAgents()` resolves, the
 * older response is discarded instead of clobbering fresher state.
 */
export function createAgentsStore(
  config: ConfigService,
  initial: AgentFile[],
  initialConflicts: string[] = [],
): AgentsStore {
  const [list, setList] = createSignal<AgentFile[]>(initial);
  const [conflicts, setConflicts] = createSignal<string[]>(initialConflicts);
  let reloadEpoch = 0;

  async function reload(): Promise<void> {
    const epoch = ++reloadEpoch;
    const summaries = await config.listAgents();
    const files = await resolveAgentFiles(config, summaries);
    if (epoch !== reloadEpoch) return;
    setList(files);
    setConflicts(findAgentConflicts(summaries));
  }

  return {
    list,
    conflicts,
    read: async (name, scope) => {
      try {
        return docToAgentFile(await config.getAgent(scope, name));
      } catch (e) {
        if (hasKernelErrorCode(e, "not_found")) return null;
        throw e;
      }
    },
    write: async (file) => {
      await config.writeAgent(file.scope, file.name, normalizeAgentWrite(file));
      await reload();
    },
    remove: async (name, scope) => {
      await config.deleteAgent(scope, name);
      await reload();
    },
    rename: async (oldName, newName, scope) => {
      await config.renameAgent(scope, oldName, newName);
      await reload();
    },
    reload,
    sharedPrompt: () => config.getSharedPrompt(),
    writeSharedPrompt: (scope, doc) => config.writeSharedPrompt(scope, doc),
    deleteSharedPrompt: (scope) => config.deleteSharedPrompt(scope),
  };
}
