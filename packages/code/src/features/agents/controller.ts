import { createMemo, createSignal, type Accessor } from "solid-js";
import type { ConfirmRequest } from "../../keys/commands.ts";
import type { Scope } from "../../adapters/settings.ts";
import type { SettingsAdapter } from "../../adapters/settings.ts";
import type { CodeConfigStore } from "../../adapters/code-config.ts";
import { GRANT_CATALOG, type GrantId } from "../../adapters/agents.ts";
import type { AgentsStore } from "../../adapters/agents-store.ts";
import {
  agentReadiness,
  isShippedAgent,
  NEW_AGENT_TEMPLATE,
  overlayAgentWrite,
  overlayIsEmpty,
  type AgentFile,
  type AgentFrontmatter,
  type EnvView,
  type GrantTier,
} from "../../adapters/agent-files.ts";
import type { AgentWrite } from "@clarvis/protocol";
import { mapAgentIssues, saveWarningsNote, type PanelIssue } from "../issues.ts";
import { createDisposeGuard } from "../dispose-guard.ts";
import type { AgentsEvent } from "./events.ts";

/** Dependencies for {@link createAgentsController}. */
export interface AgentsControllerDeps {
  agents: AgentsStore;
  settings: SettingsAdapter;
  code: CodeConfigStore;
  env: EnvView;
  scope: Accessor<Scope>;
  markDirty: (value?: boolean) => void;
  emit: (event: AgentsEvent) => void;
  confirm: (req: ConfirmRequest) => Promise<boolean>;
}

/** Grants considered "coding" grants for the simplified tier picker. */
export const CODING_GRANTS = ["read_workspace", "edit_workspace", "run_commands"];

/** Grants implied by each simplified {@link GrantTier}. */
export const TIER_GRANTS: Record<GrantTier, GrantId[]> = {
  none: [],
  read: ["read_workspace"],
  edit: ["edit_workspace"],
  exec: ["edit_workspace", "run_commands"],
};

/** Every grant an agent can hold. */
export const ALL_GRANTS = GRANT_CATALOG;

/** Ordering weight for each {@link GrantTier}, for comparisons and sorting. */
export const RANK: Record<GrantTier, number> = { none: 0, read: 1, edit: 2, exec: 3 };

/**
 * Derives the simplified grant tier implied by a raw grant list.
 *
 * @param grants - The agent's raw grant ids.
 * @returns The highest tier whose grants are all present in `grants`.
 */
export function grantTier(grants: readonly string[]): GrantTier {
  if (grants.includes("run_commands")) return "exec";
  if (grants.includes("edit_workspace")) return "edit";
  if (grants.includes("read_workspace")) return "read";
  return "none";
}

/** Normalize a typed name into a valid agent id; null when nothing usable. */
export function sanitizeAgentName(raw: string): string | null {
  const n = raw.trim().replace(/[^a-zA-Z0-9_-]/g, "-");
  return n || null;
}

/** Result of {@link AgentsController.save}. */
export type SaveOutcome = "saved" | "blocked" | "fork-needed" | "no-draft" | "error";

/** Reactive controller backing the agent editor panel: draft state, validation, and persistence. */
export interface AgentsController {
  agents: Accessor<AgentFile[]>;
  conflicts: Accessor<string[]>;
  reload: () => Promise<void>;
  draft: Accessor<AgentFile | null>;
  setDraft: (d: AgentFile | null) => void;
  openDraft: (a: AgentFile) => AgentFile;
  clearDraft: () => void;
  patchFm: (patch: Partial<AgentFrontmatter>) => void;
  setBody: (body: string) => void;
  readiness: () => ReturnType<typeof agentReadiness> | null;
  draftIssues: Accessor<PanelIssue[]>;
  toggleGrant: (id: GrantId) => void;
  toggleSpawn: (name: string) => void;
  save: () => Promise<SaveOutcome>;
  forkWithNewName: (source: AgentFile, targetScope: Scope, name: string) => Promise<void>;
  createFromTemplate: (name: string) => Promise<AgentFile | null>;
  rename: (oldName: string, newName: string, scope: Scope) => Promise<void>;
  remove: (name: string, scope: Scope) => Promise<void>;
  repointRefs: (oldName: string, newName: string) => Promise<void>;
  dispose: () => void;
}

/**
 * Builds the {@link AgentsController} that drives the agent editor panel over
 * an {@link AgentsStore}.
 *
 * @param deps - Store, settings, and UI-effect dependencies.
 * @returns The controller.
 */
export function createAgentsController(deps: AgentsControllerDeps): AgentsController {
  const store = deps.agents;
  const [draft, setDraftSignal] = createSignal<AgentFile | null>(null);
  const guard = createDisposeGuard(deps.emit);
  const disposed = guard.isDisposed;
  const emit = guard.emit;

  const reload = (): Promise<void> => store.reload();

  function setDraft(d: AgentFile | null): void {
    setDraftSignal(d);
    if (d === null) deps.markDirty(false);
  }

  function openDraft(a: AgentFile): AgentFile {
    const copy: AgentFile = {
      name: a.name,
      scope: a.scope,
      frontmatter: { ...a.frontmatter },
      body: a.body,
    };
    setDraftSignal(copy);
    return copy;
  }

  function clearDraft(): void {
    setDraftSignal(null);
    deps.markDirty(false);
  }

  /**
   * Whether `patch` would actually change the draft.
   *
   * @remarks Compared by value, so an enum round-tripped back to where it
   *   started, or an editor visited and left alone, does not mark the config
   *   `Unsaved` and later demand a discard confirmation for bytes that never
   *   changed. Structural values (`grants`, `can_spawn`, `budget`) are compared
   *   as JSON, which is exact for the frontmatter shape and cheap at the one
   *   place a field is edited.
   */
  function changesDraft(current: AgentFrontmatter, patch: Partial<AgentFrontmatter>): boolean {
    return Object.entries(patch).some(([key, next]) => {
      const before = (current as Record<string, unknown>)[key];
      if (before === next) return false;
      return JSON.stringify(before ?? null) !== JSON.stringify(next ?? null);
    });
  }

  function patchFm(patch: Partial<AgentFrontmatter>): void {
    const current = draft();
    if (current && !changesDraft(current.frontmatter, patch)) return;
    setDraftSignal((d) => (d ? { ...d, frontmatter: { ...d.frontmatter, ...patch } } : d));
    deps.markDirty(true);
  }

  function setBody(body: string): void {
    if (draft()?.body === body) return;
    setDraftSignal((d) => (d ? { ...d, body } : d));
    deps.markDirty(true);
  }

  const readiness = createMemo(() => {
    const d = draft();
    if (!d) return null;
    return agentReadiness(
      { ...d, scope: deps.scope() },
      store.list(),
      deps.settings.effective(),
      deps.env,
      deps.settings.knownGrants(),
    );
  });

  const draftIssues = createMemo<PanelIssue[]>(() => {
    const seal = readiness();
    return seal ? mapAgentIssues(seal) : [];
  });

  function toggleGrant(id: GrantId): void {
    const d = draft();
    if (!d) return;
    const cur = d.frontmatter.grants ?? [];
    const list = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    patchFm({ grants: list.length ? list : undefined });
  }

  function toggleSpawn(name: string): void {
    const d = draft();
    if (!d || name === d.name) return;
    const cur = d.frontmatter.can_spawn ?? [];
    const list = cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name];
    const patch: Partial<AgentFrontmatter> = { can_spawn: list.length ? list : undefined };
    if (d.frontmatter.default_spawn && !list.includes(d.frontmatter.default_spawn))
      patch.default_spawn = undefined;
    patchFm(patch);
  }

  async function save(): Promise<SaveOutcome> {
    const d = draft();
    if (!d) return "no-draft";
    const issues = draftIssues();
    const blocker = issues.find((i) => i.level === "error");
    if (blocker) {
      emit({ type: "save_blocked", message: blocker.message });
      return "blocked";
    }
    const targetScope = deps.scope();
    /* A shipped agent has no document to edit, so a save is not a rewrite of one
       — it creates a customization in whichever scope the panel is pointed at,
       under the same name. Only what the user actually changed is written; see
       {@link overlayAgentWrite}. */
    if (d.scope === "builtin") {
      const base = await store.read(d.name, "builtin");
      if (base === null) {
        emit({ type: "save_failed", error: new Error(`'${d.name}' is no longer shipped`) });
        return "error";
      }
      let write: AgentWrite;
      try {
        write = overlayAgentWrite(d, base);
      } catch (e) {
        emit({ type: "save_failed", error: e });
        return "error";
      }
      if (overlayIsEmpty(write)) {
        deps.markDirty(false);
        emit({ type: "unchanged", name: d.name });
        return "saved";
      }
      try {
        await store.write({
          name: d.name,
          scope: targetScope,
          frontmatter: write.frontmatter,
          body: write.body,
        });
      } catch (e) {
        emit({ type: "save_failed", error: e });
        return "error";
      }
      if (disposed()) return "saved";
      deps.markDirty(false);
      emit({ type: "saved", name: d.name, scope: targetScope });
      return "saved";
    }
    if (targetScope !== d.scope) return "fork-needed";
    try {
      await store.write({ ...d, scope: targetScope });
    } catch (e) {
      emit({ type: "save_failed", error: e });
      return "error";
    }
    if (disposed()) return "saved";
    deps.markDirty(false);
    const warned = saveWarningsNote(issues.filter((i) => i.level === "warn"));
    emit({
      type: "saved",
      name: d.name,
      scope: targetScope,
      ...(warned ? { warning: warned } : {}),
    });
    return "saved";
  }

  async function forkWithNewName(
    source: AgentFile,
    targetScope: Scope,
    name: string,
  ): Promise<void> {
    try {
      await store.write({ ...source, name, scope: targetScope });
      if (disposed()) return;
      emit({ type: "forked", source: source.name, name, scope: targetScope });
    } catch (e) {
      emit({ type: "fork_failed", error: e });
    }
  }

  async function createFromTemplate(name: string): Promise<AgentFile | null> {
    const scope = deps.scope();
    /* A shipped name is taken. Writing one here would not create an agent, it
       would silently become a customization of the shipped one — the new agent
       the user asked for would inherit grants and a prompt they never chose. */
    if (isShippedAgent(name) || (await store.read(name, scope))) {
      emit({ type: "already_exists", name, scope });
      return null;
    }
    const t = NEW_AGENT_TEMPLATE;
    try {
      await store.write({ name, scope, frontmatter: { ...t.frontmatter }, body: t.body });
      if (disposed()) return null;
      return await store.read(name, scope);
    } catch (e) {
      emit({ type: "create_failed", error: e });
      return null;
    }
  }

  async function rename(oldName: string, newName: string, scope: Scope): Promise<void> {
    try {
      await store.rename(oldName, newName, scope);
      if (disposed()) return;
      setDraftSignal((cur) => (cur && cur.name === oldName ? { ...cur, name: newName } : cur));
      emit({ type: "renamed", oldName, newName });
    } catch (e) {
      emit({ type: "rename_failed", error: e });
      return;
    }
    await repointRefs(oldName, newName);
  }

  /**
   * Delete an agent's document in one scope.
   *
   * @remarks For a name Clarvis ships this is not a deletion but a **reset**:
   *   the file removed is the user's customization, and the shipped agent comes
   *   straight back. There is no way to delete a shipped agent, which is the
   *   point — the fleet is not something a host can lose.
   */
  async function remove(name: string, scope: Scope): Promise<void> {
    try {
      await store.remove(name, scope);
    } catch (e) {
      emit({ type: "delete_failed", error: e });
      throw e;
    }
    if (disposed()) return;
    if (draft()?.name === name) clearDraft();
    emit(
      isShippedAgent(name)
        ? { type: "reset_to_shipped", name, scope }
        : { type: "deleted", name, scope },
    );
  }

  async function repointRefs(oldName: string, newName: string): Promise<void> {
    const citing = store
      .list()
      .filter(
        (x) =>
          (x.frontmatter.can_spawn ?? []).includes(oldName) ||
          x.frontmatter.default_spawn === oldName,
      );
    const defaultCites = deps.code.agentDefault() === oldName;
    if (citing.length === 0 && !defaultCites) return;
    const detail = [
      ...(citing.length ? [`agents: ${citing.map((x) => x.name).join(", ")}`] : []),
      ...(defaultCites ? ["the default agent in code.json"] : []),
    ];
    const total = citing.length + (defaultCites ? 1 : 0);
    const ok = await deps.confirm({
      message: `re-point ${total} reference${total === 1 ? "" : "s"} to '${newName}'?`,
      detail,
      confirmLabel: "re-point",
      cancelLabel: "leave",
    });
    if (!ok || disposed()) return;
    for (const x of citing) {
      const fm = { ...x.frontmatter };
      if (fm.can_spawn) fm.can_spawn = fm.can_spawn.map((s) => (s === oldName ? newName : s));
      if (fm.default_spawn === oldName) fm.default_spawn = newName;
      /* A shipped agent citing the renamed one has no document of its own, so
         the re-point becomes a customization: the smallest one that changes the
         spawn list and nothing else. */
      const next: AgentFile = { ...x, frontmatter: fm };
      if (x.scope === "builtin") {
        const targetScope = deps.scope();
        const write = overlayAgentWrite(next, x);
        if (!overlayIsEmpty(write))
          await store.write({
            name: x.name,
            scope: targetScope,
            frontmatter: write.frontmatter,
            body: write.body,
          });
      } else {
        await store.write({ ...next, scope: x.scope });
      }
      if (disposed()) return;
    }
    if (defaultCites) deps.code.writeAgentDefault(deps.scope(), newName);
  }

  return {
    agents: store.list,
    conflicts: store.conflicts,
    reload,
    draft,
    setDraft,
    openDraft,
    clearDraft,
    patchFm,
    setBody,
    readiness,
    draftIssues,
    toggleGrant,
    toggleSpawn,
    save,
    forkWithNewName,
    createFromTemplate,
    rename,
    remove,
    repointRefs,
    dispose: () => {
      guard.dispose();
      clearDraft();
    },
  };
}
