import type { JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { detachObserved } from "../../core/tasks.ts";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { Scope, SharedPromptView } from "@clarvis/protocol";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import { tone } from "../../theme/tone.ts";
import type { ViewHost } from "../../keys/commands.ts";
import type { SettingsAdapter } from "../../adapters/settings.ts";
import type { CodeConfigStore } from "../../adapters/code-config.ts";
import type { GrantId } from "../../adapters/agents.ts";
import type { AgentsStore } from "../../adapters/agents-store.ts";
import {
  agentReadiness,
  isShippedAgent,
  type AgentFile,
  type AgentFrontmatter,
  type EnvView,
} from "../../adapters/agent-files.ts";
import { supportedReasoningEfforts } from "../../adapters/effort-levels.ts";
import type { ModelsCatalog } from "../../adapters/models-catalog.ts";
import {
  ALL_GRANTS,
  CODING_GRANTS,
  createAgentsController,
  grantTier,
  RANK,
  sanitizeAgentName,
  TIER_GRANTS,
  type AgentsController,
} from "../../features/agents/controller.ts";
import { presentAgentsEvent } from "../../features/agents/events.ts";
import type { HintTone } from "../hint.ts";
import { registerLevel, verb, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { issueSet } from "./validation.ts";
import {
  bindLevelKeys,
  createFieldEditor,
  Dash,
  LevelHost,
  SectionHeader,
  SettingRow,
  SelectableList,
} from "./view-host.tsx";
import type { CatalogPickerSpec } from "./CatalogPicker.tsx";
import {
  configuredModelCapabilities,
  knownToLackReasoning,
  type CatalogRow,
} from "./catalog-pick.ts";
import { modelPickerSpec } from "./pick-model.ts";
import { truncateEnd } from "../truncate.ts";
import { PickerRow } from "../overlays/PickerRow.tsx";
import { scrollbarOptions } from "../../theme/surfaces.ts";
import { followSelection } from "../../ui/patterns/list-navigation.ts";

/** Data and actions {@link AgentsPanel} needs from its host. */
export interface AgentsDeps {
  agents: AgentsStore;
  settings: SettingsAdapter;
  catalog: ModelsCatalog | null;
  code: CodeConfigStore;
  env: EnvView;
  notify: (message: string, tone?: HintTone) => void;
  controller?: AgentsController;
}

const EDITOR_FIELDS = [
  "description",
  "model",
  "grants",
  "can_spawn",
  "default_spawn",
  "iteration_limit",
  "reasoning_effort",
  "base_prompt",
] as const;

type Effort = AgentFrontmatter["reasoning_effort"];

/**
 * Config panel for agent profiles: lists agents with their grants, model,
 * iteration limit and readiness, and drills into a selected agent's editable
 * frontmatter fields (model, grants, spawn settings, reasoning effort,
 * base prompt).
 *
 * @remarks
 * Delegates mutation and validation to an {@link AgentsController} (built
 * here when `deps.controller` is not supplied, and disposed on cleanup).
 */
export function AgentsPanel(host: ViewHost, deps: AgentsDeps): JSX.Element {
  const { settings, env } = deps;
  const fe = createFieldEditor(host.interaction, host.active);

  const ownedController = deps.controller
    ? null
    : createAgentsController({
        agents: deps.agents,
        settings,
        code: deps.code,
        env,
        scope: () => host.scope(),
        markDirty: (value) => host.markDirty(value),
        emit: (event) => {
          const notice = presentAgentsEvent(event);
          deps.notify(notice.message, notice.tone);
        },
        confirm: (req) => host.confirm(req),
      });
  const ctrl = deps.controller ?? ownedController!;
  onCleanup(() => ownedController?.dispose());

  const agents = ctrl.agents;
  detachObserved("agents_reload", () => ctrl.reload());
  const [sel, setSel] = createSignal(1);
  const [row, setRow] = createSignal(0);
  const [picker, setPicker] = createSignal<CatalogPickerSpec | null>(null);
  const [shared, setShared] = createSignal<SharedPromptView | null>(null);
  const [sharedOpen, setSharedOpen] = createSignal(false);
  detachObserved("shared_prompt_load", async () => {
    try {
      setShared(await deps.agents.sharedPrompt());
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), "error");
    }
  });

  host.bindScope({ mode: "retarget" });

  const listCount = (): number => agents().length + 1;
  const clampSel = (i: number): number => Math.max(0, Math.min(listCount() - 1, i));
  const selectedAgent = (): AgentFile | undefined => {
    const index = clampSel(sel()) - 1;
    return index < 0 ? undefined : agents()[index];
  };
  const clampRow = (i: number): number => Math.max(0, Math.min(EDITOR_FIELDS.length - 1, i));
  let editorScrollEl: ScrollBoxRenderable | undefined;
  followSelection(
    () => editorScrollEl,
    "agent-field-",
    () => clampRow(row()),
  );

  const editorIssues = issueSet(ctrl.draftIssues);

  function forkDraftWithNewName(source: AgentFile, targetScope: Scope): void {
    fe.start(`fork '${source.name}' to ${targetScope} as`, source.name, (name) => {
      const n = sanitizeAgentName(name);
      if (!n) return;
      detachObserved("agent_fork", () => ctrl.forkWithNewName(source, targetScope, n));
    });
  }

  async function save(): Promise<void> {
    const d = ctrl.draft();
    if (!d) return;
    const outcome = await ctrl.save();
    if (outcome === "fork-needed") forkDraftWithNewName(d, host.scope());
  }
  host.onSave(save);

  function openEditor(a: AgentFile): void {
    setSharedOpen(false);
    if (host.scope() !== a.scope) host.toggleScope();
    ctrl.openDraft(a);
    setRow(0);
    host.level.push(a.name);
  }

  function withDraftGuard(target: string | null, next: () => void): void {
    const d = ctrl.draft();
    const conflicted = host.dirty() && (target === null || d?.name === target);
    if (!conflicted) return next();
    detachObserved("agent_draft_guard", () =>
      host
        .confirm({ message: "Unsaved changes " + glyph("emDash") + " discard them?", danger: true })
        .then((ok) => {
          if (!ok) return;
          ctrl.clearDraft();
          next();
        }),
    );
  }

  function openConflictPicker(a: AgentFile): void {
    const scopes: Scope[] = ["global", "workspace"];
    setPicker({
      title: `'${a.name}' exists in both scopes ${glyph("emDash")} open which?`,
      rows: () =>
        scopes.map((scope) => ({
          id: scope,
          label: scope,
          haystack: scope,
          detail: scope === a.scope ? "effective at run time" : undefined,
        })),
      onPick: (scope) => {
        setPicker(null);
        detachObserved("agent_conflict_open", async () => {
          const file = await deps.agents.read(a.name, scope as Scope);
          if (file) openEditor(file);
        });
      },
      onClose: () => setPicker(null),
    });
  }

  async function reloadShared(): Promise<void> {
    setShared(await deps.agents.sharedPrompt());
  }

  function openShared(): void {
    setSharedOpen(true);
    host.level.push("shared");
  }

  function editShared(): void {
    const view = shared();
    const draft = view?.prompt ?? "";
    fe.startMultiline("Shared prompt", draft, (text) => {
      detachObserved("shared_prompt_save", async () => {
        const next = await deps.agents.writeSharedPrompt(host.scope(), {
          mode: "replace",
          body: text,
        });
        setShared(next);
      });
    });
  }

  function disableShared(): void {
    detachObserved("shared_prompt_disable", async () => {
      const next = await deps.agents.writeSharedPrompt(host.scope(), {
        mode: "disabled",
        body: "",
      });
      setShared(next);
    });
  }

  function resetShared(): void {
    detachObserved("shared_prompt_reset", async () => {
      await deps.agents.deleteSharedPrompt(host.scope());
      await reloadShared();
    });
  }

  function openSelected(): void {
    if (clampSel(sel()) === 0) {
      openShared();
      return;
    }
    const a = selectedAgent();
    if (!a) return;
    if (a.invalid) {
      deps.notify(
        `'${a.name}' has invalid frontmatter ${glyph("emDash")} edit the .md directly (${a.invalid})`,
      );
      return;
    }
    // Re-opening the very agent whose draft is unsaved resumes that draft. It
    // used to fall through the guard and offer only discard-or-stay, so the
    // user's own edits were the thing standing between them and their own edits.
    const draft = ctrl.draft();
    if (host.dirty() && draft?.name === a.name && draft.scope === a.scope) {
      resumeDraft(draft);
      return;
    }
    if (ctrl.conflicts().includes(a.name)) {
      withDraftGuard(null, () => openConflictPicker(a));
      return;
    }
    withDraftGuard(null, () => openEditor(a));
  }

  /** Re-enters an already-staged draft without reloading it from disk. */
  function resumeDraft(draft: AgentFile): void {
    if (host.scope() !== draft.scope) host.toggleScope();
    setRow(0);
    host.level.push(draft.name);
  }

  function newAgent(): void {
    withDraftGuard(null, () =>
      fe.start("new agent name", "", (name) => {
        const n = sanitizeAgentName(name);
        if (!n) return;
        detachObserved("agent_create", async () => {
          const created = await ctrl.createFromTemplate(n);
          if (created) openEditor(created);
        });
      }),
    );
  }

  function renameSelected(): void {
    const a = selectedAgent();
    if (!a) return;
    const scope = storedScope(a);
    if (scope === null) return refuseRename(a.name);
    withDraftGuard(a.name, () =>
      fe.start(`rename '${a.name}' to`, a.name, (name) => {
        const n = sanitizeAgentName(name);
        if (!n || n === a.name) return;
        detachObserved("agent_rename", () => ctrl.rename(a.name, n, scope));
      }),
    );
  }

  /**
   * Decline to rename an agent that has no document, before asking for a name.
   *
   * @remarks Refusing *after* the prompt would collect a name the panel had
   *   already decided it could not use.
   */
  const refuseRename = (name: string): void => {
    deps.notify(`'${name}' is shipped with Clarvis; fork it under a new name instead`);
  };

  /** Whether Clarvis ships this agent, i.e. deleting its file is a reset. */
  const isShipped = (a: AgentFile): boolean => isShippedAgent(a.name);

  /**
   * Confirm text that says what deleting the file will actually do.
   *
   * @param named - whether to name the scope, as the editor's own delete does
   *   and the list's does not.
   * @remarks For an agent Clarvis ships, the file being removed is the user's
   *   customization and the shipped agent comes back — calling that "delete"
   *   would promise something the operation cannot do.
   */
  const destructiveMessage = (a: AgentFile, scope: Scope, named: boolean): string =>
    isShipped(a)
      ? `reset '${a.name}' to the shipped default, discarding your ${scope} customization?`
      : named
        ? `delete agent '${a.name}' (${scope})?`
        : `delete agent '${a.name}'?`;

  /**
   * Ask what a destructive verb means for `a`, and refuse it when the agent has
   * no document to act on.
   *
   * @returns the scope holding the agent's file, or `null` when Clarvis ships it
   *   and nothing overlays it — there is nothing to rename or delete, and saying
   *   so beats a confirm dialog that would fail.
   */
  function storedScope(a: AgentFile): Scope | null {
    return a.scope === "builtin" ? null : a.scope;
  }

  function renameDraft(): void {
    const d = ctrl.draft();
    if (!d) return;
    const scope = storedScope(d);
    if (scope === null) return refuseRename(d.name);
    fe.start(`rename '${d.name}' to`, d.name, (name) => {
      const n = sanitizeAgentName(name);
      if (!n || n === d.name) return;
      detachObserved("agent_draft_rename", () => ctrl.rename(d.name, n, scope));
    });
  }

  function deleteDraft(): void {
    const d = ctrl.draft();
    if (!d) return;
    const scope = storedScope(d);
    if (scope === null) {
      deps.notify(`'${d.name}' is shipped with Clarvis and cannot be deleted`);
      return;
    }
    detachObserved("agent_draft_delete", () =>
      host
        .confirm({
          message: destructiveMessage(d, scope, true),
          danger: true,
          confirmLabel: isShipped(d) ? "reset" : "delete",
          cancelLabel: "keep",
        })
        .then(async (ok) => {
          if (!ok) return;
          try {
            await ctrl.remove(d.name, scope);
          } catch {
            return;
          }
          host.level.pop();
        }),
    );
  }

  function deleteSelected(): void {
    const a = selectedAgent();
    if (!a) return;
    const scope = storedScope(a);
    if (scope === null) {
      deps.notify(`'${a.name}' is shipped with Clarvis and cannot be deleted`);
      return;
    }
    const citing = agents()
      .filter((x) => (x.frontmatter.can_spawn ?? []).includes(a.name))
      .map((x) => x.name);
    withDraftGuard(a.name, () => {
      detachObserved("agent_delete", () =>
        host
          .confirm({
            message: destructiveMessage(a, scope, false),
            danger: true,
            detail: citing.length ? [`spawned by: ${citing.join(", ")}`] : undefined,
            confirmLabel: isShipped(a) ? "reset" : "delete",
            cancelLabel: "keep",
          })
          .then(async (ok) => {
            if (!ok) return;
            try {
              await ctrl.remove(a.name, scope);
            } catch {
              return;
            }
            setSel((s) => Math.max(0, s - 1));
          }),
      );
    });
  }

  function grantRows(): CatalogRow[] {
    const cur = new Set(ctrl.draft()?.frontmatter.grants ?? []);
    return ALL_GRANTS.map((g) => ({
      id: g.id,
      label: g.id,
      haystack: g.id,
      detail: g.detail,
      added: cur.has(g.id),
    }));
  }

  function openGrantsPicker(): void {
    const d = ctrl.draft();
    if (!d) return;
    setPicker({
      title: `grants ${glyph("emDash")} ${d.name}`,
      stayOpen: true,
      counterLabel: "granted",
      counter: () => ctrl.draft()?.frontmatter.grants?.length ?? 0,
      rows: grantRows,
      onClose: () => setPicker(null),
      onPick: (id) => ctrl.toggleGrant(id as GrantId),
    });
  }

  function spawnRows(): CatalogRow[] {
    const d = ctrl.draft();
    const cur = new Set(d?.frontmatter.can_spawn ?? []);
    const rows: CatalogRow[] = agents()
      .filter((a) => a.name !== d?.name)
      .map((a) => {
        const tier = grantTier(a.frontmatter.grants ?? []);
        const ready =
          !a.invalid &&
          agentReadiness(a, agents(), settings.effective(), env, settings.knownGrants()).runnable;
        return {
          id: a.name,
          label: a.name,
          haystack: a.name,
          columns: [
            { text: tier, width: 5 },
            { text: truncateEnd(a.frontmatter.model ?? "(inherit)", 18), width: 18 },
            { text: ready ? glyph("success") : glyph("error"), width: 4 },
          ],
          added: cur.has(a.name),
        };
      });
    for (const name of cur)
      if (name !== d?.name && !agents().some((a) => a.name === name))
        rows.push({
          id: name,
          label: name,
          haystack: name,
          detail: "not a known agent yet",
          added: true,
        });
    return rows;
  }

  function openSpawnPicker(): void {
    const d = ctrl.draft();
    if (!d) return;
    setPicker({
      title: `can_spawn ${glyph("emDash")} ${d.name}`,
      stayOpen: true,
      counterLabel: "spawnable",
      counter: () => ctrl.draft()?.frontmatter.can_spawn?.length ?? 0,
      rows: spawnRows,
      onManual: () => {
        setPicker(null);
        fe.start("agent name (forward refs allowed)", "", (v) => {
          const n = v.trim();
          if (n) ctrl.toggleSpawn(n);
        });
      },
      onClose: () => setPicker(null),
      onPick: (name) => ctrl.toggleSpawn(name),
    });
  }

  function editField(field: (typeof EDITOR_FIELDS)[number]): void {
    const d = ctrl.draft();
    if (!d) return;
    const fm = d.frontmatter;
    if (field === "grants") {
      openGrantsPicker();
      return;
    }
    if (field === "model") {
      const spec = modelPickerSpec({
        fe,
        settings,
        current: fm.model ?? "",
        commit: (v) => ctrl.patchFm({ model: v || undefined }),
        close: () => setPicker(null),
      });
      if (spec) setPicker(spec);
      return;
    }
    if (field === "base_prompt") {
      fe.startMultiline("Instructions", d.body, (v) => ctrl.setBody(v));
      return;
    }
    if (field === "iteration_limit") {
      fe.startNumber("Iteration limit", fm.iteration_limit, {
        min: 1,
        commit: (v) => ctrl.patchFm({ iteration_limit: v }),
        notify: deps.notify,
      });
      return;
    }
    if (field === "reasoning_effort") {
      const model = fm.model ?? settings.effective().default_model;
      const levels = supportedReasoningEfforts(
        deps.catalog,
        settings.effective().providers ?? [],
        model,
      );
      fe.startEnum(
        "Sub-agent effort",
        [{ label: "Use /effort default", value: "" }, ...(levels ?? [])],
        fm.reasoning_effort ?? "",
        (v) => ctrl.patchFm({ reasoning_effort: (v || undefined) as Effort }),
      );
      return;
    }
    if (field === "can_spawn") {
      openSpawnPicker();
      return;
    }
    if (field === "default_spawn") {
      const options = [
        ...(fm.can_spawn ?? []).map((n) => ({ label: n, value: n })),
        { label: "Choose when delegating", value: "" },
      ];
      fe.startEnum("Default delegate", options, fm.default_spawn ?? "", (v) =>
        ctrl.patchFm({ default_spawn: v || undefined }),
      );
      return;
    }
    fe.start(field === "description" ? "Description" : field, (fm[field] as string) ?? "", (v) =>
      ctrl.patchFm({ [field]: v.trim() || undefined }),
    );
  }

  function specFor(depth: number): LevelSpec {
    if (depth === 0)
      return {
        nav: {
          count: listCount,
          index: sel,
          setIndex: setSel,
          activate: { label: "open", run: openSelected },
        },
        verbs: [
          verb("add", newAgent),
          verb("rename", renameSelected),
          verb("delete", deleteSelected),
        ],
      };
    if (sharedOpen()) {
      return {
        nav: {
          count: () => 1,
          index: row,
          setIndex: setRow,
          activate: { label: "edit", run: editShared },
        },
        verbs: [{ key: "d", label: "disable", run: disableShared }, verb("clear", resetShared)],
      };
    }
    return {
      nav: {
        count: () => EDITOR_FIELDS.length,
        index: row,
        setIndex: setRow,
        activate: { label: "edit", run: () => editField(EDITOR_FIELDS[clampRow(row())]!) },
      },
      verbs: [verb("rename", renameDraft), verb("delete", deleteDraft)],
    };
  }

  bindLevelKeys({
    host,
    editor: fe,
    suspend: () => picker() !== null,
    register: (enabled) =>
      registerLevel(host.interaction.keymap, { ...specFor(host.level.depth()), enabled }),
  });

  const selBlockers = (): { text: string; fg: string } | null => {
    if (clampSel(sel()) === 0) {
      const view = shared();
      if (view === null) return null;
      const layer = host.scope() === "workspace" ? view.layers.workspace : view.layers.global;
      if (layer?.status === "rejected") {
        return {
          text: glyph("error") + " " + (layer.reason ?? "override rejected"),
          fg: tokens.del,
        };
      }
      return {
        text: glyph("success") + " " + view.source,
        fg: tokens.add,
      };
    }
    const a = selectedAgent();
    if (!a) return null;
    if (a.invalid)
      return { text: glyph("error") + " invalid frontmatter: " + a.invalid, fg: tokens.del };
    if (ctrl.conflicts().includes(a.name)) {
      const other = a.scope === "global" ? "workspace" : "global";
      return {
        text: `${glyph("warning")} also defined in ${other} ${glyph("emDash")} open to view/resolve`,
        fg: tokens.warn,
      };
    }
    const seal = agentReadiness(a, agents(), settings.effective(), env, settings.knownGrants());
    if (seal.runnable) return { text: glyph("success") + " runnable", fg: tokens.add };
    const first = seal.issues[0]?.message ?? "not runnable";
    const more = seal.issues.length > 1 ? `  (+${seal.issues.length - 1} more)` : "";
    return { text: glyph("error") + " " + first + more, fg: tokens.del };
  };

  function listBody(): JSX.Element {
    const sharedView = (): SharedPromptView | null => shared();
    const sharedStatus = (): string => {
      const view = sharedView();
      if (view === null) return "loading";
      const layer = host.scope() === "workspace" ? view.layers.workspace : view.layers.global;
      if (layer?.status === "rejected") return "rejected";
      if (view.source === "disabled") return "disabled";
      return view.source;
    };
    return (
      <box flexDirection="column">
        <PickerRow
          selected={sel() === 0}
          base={tokens.bg}
          cells={[
            { width: 11, text: "Shared", fg: tokens.accent2 },
            { grow: true, text: "Shared prompt", fg: sel() === 0 ? tokens.fg : tokens.muted },
            { width: 8, text: "", fg: tokens.muted },
            { width: 22, shrink: true, text: sharedStatus(), fg: tokens.muted },
            { width: 8, text: "", fg: tokens.muted },
            { width: 4, text: "", fg: tokens.muted },
            { width: 16, text: host.scope(), fg: tokens.muted },
          ]}
        />
        <PickerRow
          selected={false}
          base={tokens.bg}
          cells={[
            { width: 11, text: "role", fg: tokens.muted },
            { grow: true, text: "name", fg: tokens.muted },
            { width: 8, text: "grants", fg: tokens.muted },
            { width: 22, shrink: true, text: "model", fg: tokens.muted },
            { width: 8, text: "iters", fg: tokens.muted },
            { width: 4, text: "ok", fg: tokens.muted },
            { width: 16, text: "scope", fg: tokens.muted },
          ]}
        />
        <SelectableList<AgentFile>
          each={agents}
          sel={() => Math.max(0, sel() - 1)}
          idPrefix="agent-row-"
          empty={() => ({ text: "no agents " + glyph("emDash") + " use Add to create one" })}
          trailing={
            <Show when={selBlockers()}>
              <text flexShrink={0} fg={selBlockers()!.fg}>
                {"  " + selBlockers()!.text}
              </text>
            </Show>
          }
          row={(a, i) => {
            const on = (): boolean => sel() === i() + 1;
            const fm = a.frontmatter;
            const lead = (fm.can_spawn?.length ?? 0) > 0;
            const tier = grantTier(fm.grants ?? []);
            const inert = RANK[tier] > RANK[env.maxGrant];
            const ready =
              !a.invalid &&
              agentReadiness(a, agents(), settings.effective(), env, settings.knownGrants())
                .runnable;
            return (
              <PickerRow
                selected={on()}
                base={tokens.bg}
                cells={[
                  {
                    width: 11,
                    text: lead ? "Lead" : "Sub-agent",
                    fg: lead ? tokens.accent2 : tokens.muted,
                  },
                  { grow: true, text: a.name, fg: on() ? tokens.fg : tokens.muted },
                  {
                    width: 8,
                    text: tier + (inert ? " " + glyph("warning") : ""),
                    fg: inert ? tokens.warn : tokens.muted,
                  },
                  {
                    width: 22,
                    shrink: true,
                    text: fm.model ?? "(inherit)",
                    fg: tokens.muted,
                  },
                  {
                    width: 8,
                    text: "it " + (fm.iteration_limit ?? glyph("emDash")),
                    fg: tokens.muted,
                  },
                  {
                    width: 4,
                    text: ready ? glyph("success") : glyph("error"),
                    fg: ready ? tokens.add : tokens.del,
                  },
                  {
                    width: 16,
                    text: a.scope + (ctrl.conflicts().includes(a.name) ? " shadow" : ""),
                    fg: tokens.muted,
                  },
                ]}
              />
            );
          }}
        />
      </box>
    );
  }

  function editorBody(): JSX.Element {
    const d = ctrl.draft();
    if (!d) return <Dash />;
    const fm = d.frontmatter;
    const issues = ctrl.draftIssues();
    const tier = grantTier(fm.grants ?? []);
    const nonCoding = (fm.grants ?? []).filter((x) => !CODING_GRANTS.includes(x));
    const grantsValue =
      tier +
      (TIER_GRANTS[tier].length ? `  (${TIER_GRANTS[tier].join(" + ")})` : "") +
      (nonCoding.length ? `  + ${nonCoding.join(" + ")}` : "");
    const effectiveTierSummary =
      tier === "exec" && RANK.exec > RANK[env.maxGrant]
        ? `${env.maxGrant} effective ${glyph("separator")} ${tier} configured`
        : tier;
    const modelLacksReasoning = knownToLackReasoning(
      configuredModelCapabilities(settings.effective().providers ?? [], fm.model),
    );
    return (
      <scrollbox
        ref={(el: ScrollBoxRenderable) => (editorScrollEl = el)}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        verticalScrollbarOptions={scrollbarOptions()}
      >
        <box flexDirection="column">
          <SectionHeader label="Identity" />
          <SettingRow
            id="agent-field-0"
            setting={{
              label: "Description",
              summary: `${fm.description ? "custom description" : "not set"} ${glyph("separator")} ${d.scope} ${glyph("separator")} next run`,
              configured: fm.description ? "custom description" : "not set",
              effective: fm.description ? "Custom description active" : "No description",
              source: `${d.scope} Agent Profile`,
              applies: "next run",
              mutation: "staged",
            }}
            selected={row() === 0}
            expanded={row() === 0}
          />
          <Show when={row() === 0 && fm.description}>
            <text fg={tokens.muted} wrapMode="word" paddingLeft={4}>
              {fm.description}
            </text>
          </Show>
          <SettingRow
            id="agent-field-1"
            setting={{
              label: "Sub-agent model",
              configured: fm.model ?? "inherit",
              effective: fm.model ?? settings.effective().default_model ?? "No model configured",
              source: fm.model ? `${d.scope} Agent Profile` : "effective settings",
              applies: "when spawned",
              mutation: "staged",
            }}
            selected={row() === 1}
            expanded={row() === 1}
          />
          <Show when={editorIssues.for("model")}>
            <text fg={tokens.del} wrapMode="word" paddingLeft={4}>
              {editorIssues.for("model")!.message}
            </text>
          </Show>
          <SectionHeader label="Permissions and delegation" />
          <SettingRow
            id="agent-field-2"
            setting={{
              label: "Permissions",
              summary: `${effectiveTierSummary} ${glyph("separator")} ${(fm.grants ?? []).length} grants ${glyph("separator")} ${d.scope} ${glyph("separator")} next run`,
              configured: grantsValue,
              effective:
                tier === "exec" && RANK.exec > RANK[env.maxGrant]
                  ? `${env.maxGrant} (host ceiling)`
                  : grantsValue,
              source: `${d.scope} Agent Profile`,
              applies: "next run",
              mutation: "staged",
            }}
            selected={row() === 2}
            expanded={row() === 2}
          />
          <SettingRow
            id="agent-field-3"
            setting={{
              label: "Can delegate to",
              configured: (fm.can_spawn ?? []).join(", ") || "none",
              effective: (fm.can_spawn ?? []).join(", ") || "No delegation",
              source: `${d.scope} Agent Profile`,
              applies: "next run",
              mutation: "staged",
            }}
            selected={row() === 3}
            expanded={row() === 3}
          />
          <Show when={editorIssues.for("can_spawn")}>
            <text fg={tokens.del} wrapMode="word" paddingLeft={4}>
              {editorIssues.for("can_spawn")!.message}
            </text>
          </Show>
          <SettingRow
            id="agent-field-4"
            setting={{
              label: "Default delegate",
              configured: fm.default_spawn ?? "not set",
              effective: fm.default_spawn ?? "Choose when delegating",
              source: `${d.scope} Agent Profile`,
              applies: "next run",
              mutation: "staged",
            }}
            selected={row() === 4}
            expanded={row() === 4}
          />
          <Show when={editorIssues.for("default_spawn")}>
            <text fg={tokens.del} wrapMode="word" paddingLeft={4}>
              {editorIssues.for("default_spawn")!.message}
            </text>
          </Show>
          <SectionHeader label="Execution" />
          <SettingRow
            id="agent-field-5"
            setting={{
              label: "Iteration limit",
              configured: fm.iteration_limit == null ? "inherit" : String(fm.iteration_limit),
              effective: String(fm.iteration_limit ?? env.iterationDefault),
              source: fm.iteration_limit == null ? "host environment" : `${d.scope} Agent Profile`,
              applies: "next run",
              mutation: "staged",
            }}
            selected={row() === 5}
            expanded={row() === 5}
          />
          <SettingRow
            id="agent-field-6"
            setting={{
              label: "Sub-agent effort",
              configured: fm.reasoning_effort ?? "inherit",
              effective:
                fm.reasoning_effort ??
                settings.effective().default_reasoning_effort ??
                "Provider default",
              source: fm.reasoning_effort ? `${d.scope} Agent Profile` : "effective settings",
              applies: "when spawned",
              mutation: "staged",
            }}
            selected={row() === 6}
            expanded={row() === 6}
          />
          <Show when={modelLacksReasoning}>
            <text fg={tokens.warn} wrapMode="word" paddingLeft={4}>
              {`${glyph("warning")} This model's catalog entry does not declare reasoning support`}
            </text>
          </Show>
          <SettingRow
            id="agent-field-7"
            setting={{
              label: "Instructions",
              configured: d.body ? "custom instructions" : "none",
              effective: d.body ? "Custom instructions active" : "No additional instructions",
              source: `${d.scope} Agent Profile`,
              applies: "next run",
              mutation: "staged",
            }}
            selected={row() === 7}
            expanded={row() === 7}
          />
          <Show when={row() === 7 && d.body}>
            <text fg={tokens.muted} wrapMode="word" paddingLeft={4}>
              {d.body}
            </text>
          </Show>
          <box flexDirection="column" paddingTop={1}>
            <Show when={issues.length === 0}>
              <text flexShrink={0} fg={tokens.add}>
                {"  " + glyph("success") + " runnable"}
              </text>
            </Show>
            <For each={issues.slice(0, 3)}>
              {(issue) => (
                <text flexShrink={0} fg={tone(issue.level).fg}>
                  {"  " + tone(issue.level).glyph + " " + issue.message}
                </text>
              )}
            </For>
            <Show when={issues.length > 3}>
              <text flexShrink={0} fg={tokens.muted}>
                {`  (+${issues.length - 3} more)`}
              </text>
            </Show>
          </box>
        </box>
      </scrollbox>
    );
  }

  function sharedEditorBody(): JSX.Element {
    const view = shared();
    if (view === null) return <Dash />;
    const scope = host.scope();
    const layer = scope === "workspace" ? view.layers.workspace : view.layers.global;
    const path = scope === "workspace" ? view.paths.workspace : view.paths.global;
    const status = layer?.status ?? "inherited";
    const origin = view.source === "disabled" ? "disabled" : view.source;
    return (
      <box flexDirection="column">
        <SectionHeader label="Shared prompt" />
        <SettingRow
          id="shared-origin"
          setting={{
            label: "Origin",
            configured: origin,
            effective: origin,
            source: path ?? "builtin",
            applies: "next run",
            mutation: "immediate",
          }}
          selected
          expanded
        />
        <SettingRow
          id="shared-status"
          setting={{
            label: "Status",
            configured: status,
            effective: layer?.reason ?? status,
            source: path ?? "builtin",
            applies: "next run",
            mutation: "immediate",
          }}
          selected={false}
          expanded={status === "rejected"}
        />
        <Show when={view.prompt}>
          <text fg={tokens.muted} wrapMode="word" paddingLeft={4}>
            {view.prompt}
          </text>
        </Show>
        <Show when={status === "rejected" && layer?.reason}>
          <text fg={tokens.del} wrapMode="word" paddingLeft={4}>
            {layer?.reason}
          </text>
        </Show>
      </box>
    );
  }

  return (
    <LevelHost
      host={host}
      editor={fe}
      picker={picker}
      levels={[
        { title: "Agents", body: listBody },
        { title: "Agents", body: () => (sharedOpen() ? sharedEditorBody() : editorBody()) },
      ]}
    />
  );
}
