import type { JSX } from "solid-js";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { AGENTS_DIR, AGENTS_PLUGINS_DIR, CLARVIS_DIR } from "@clarvis/paths";
import type {
  ExtensionProfileCompositionInput,
  ExtensionProfileCompositionPreview,
  ExtensionProfileDefinition,
  ExtensionProfileDefinitionView,
  ExtensionProfileInventory,
  ExtensionProfilePluginRef,
  ExtensionProfileRef,
  ExtensionProfileSelectionScope,
  ExtensionProfileService,
  ExtensionProfileSkillRef,
  ResolvedExtensionProfile,
  ResolvedExtensionProfilePlugin,
} from "@clarvis/protocol";
import type { MarketplaceListing, MarketplaceSource } from "../../adapters/marketplace.ts";
import type { PluginView } from "../../adapters/plugins.ts";
import { errorText } from "../../adapters/errors.ts";
import { detachObserved } from "../../core/tasks.ts";
import { uiCommand } from "../../keys/actions.ts";
import type { ViewHost } from "../../keys/commands.ts";
import { glyph } from "../../theme/glyphs.ts";
import { tokens } from "../../theme/tokens.ts";
import { tone } from "../../theme/tone.ts";
import { scrollbarOptions } from "../../theme/surfaces.ts";
import { LAYER, registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { BrandBanner, firstRunSplashFits } from "../Splash.tsx";
import { formatElapsed, spinnerChar, tickNow, useSpinnerClock } from "../spinner.ts";
import type { CatalogRow } from "./catalog-pick.ts";
import type { CatalogPickerSpec } from "./CatalogPicker.tsx";
import {
  bindLevelKeys,
  createFieldEditor,
  EmptyHint,
  LevelHost,
  SectionHeader,
} from "./view-host.tsx";

type SetupStep = 0 | 1 | 2 | 3 | 4 | 5 | 6;

interface ExtensionSetupDraft {
  selectionScope: ExtensionProfileSelectionScope;
  ref: { scope: "global" | "workspace"; name: string };
  definition: ExtensionProfileDefinition;
  expectedRevision: string | null;
  savedDefinition?: ExtensionProfileDefinition;
}

interface SetupCompletion {
  reconnect: { ok: boolean; message: string };
}

type ExtensionChoice =
  | { kind: "plugin"; plugin: ResolvedExtensionProfilePlugin }
  | { kind: "skill"; skill: ExtensionProfileInventory["standalone_skills"][number] }
  | { kind: "listing"; listing: MarketplaceListing };

/** Data and effects needed by the guided Extensions setup. */
export interface ExtensionsHubDeps {
  extensionProfiles: ExtensionProfileService;
  definitions: () => readonly ExtensionProfileDefinitionView[];
  inventory: () => ExtensionProfileInventory | undefined;
  current: () => ResolvedExtensionProfile | undefined;
  listings: () => readonly MarketplaceListing[];
  sources: () => readonly MarketplaceSource[];
  loading: () => boolean;
  loadError: () => string | undefined;
  install: (listing: MarketplaceListing, source: "agents" | "clarvis") => Promise<PluginView>;
  refresh: (inventory?: boolean) => Promise<void>;
  reconnect: () => Promise<{ ok: boolean; message: string }>;
  runActive: () => boolean;
  notify: (message: string, tone?: "success" | "warn" | "error") => void;
  openChild: (cmd: string) => void;
  initialExtensionProfile?: ExtensionProfileRef;
  initialPlugin?: ExtensionProfilePluginRef;
}

const NAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;

function extensionProfileId(ref: ExtensionProfileRef): string {
  return `${ref.scope}:${ref.name}`;
}

function pluginId(ref: ExtensionProfilePluginRef): string {
  return `${ref.scope}/${ref.source}/${ref.name}`;
}

function skillId(ref: ExtensionProfileSkillRef): string {
  return `${ref.scope}/${ref.source}/${ref.name}`;
}

function samePlugin(left: ExtensionProfilePluginRef, right: ExtensionProfilePluginRef): boolean {
  return left.scope === right.scope && left.source === right.source && left.name === right.name;
}

function sameSkill(left: ExtensionProfileSkillRef, right: ExtensionProfileSkillRef): boolean {
  return left.scope === right.scope && left.source === right.source && left.name === right.name;
}

function sameDefinition(
  left: ExtensionProfileDefinition,
  right: ExtensionProfileDefinition,
): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.description === right.description &&
    left.plugins.length === right.plugins.length &&
    left.plugins.every((plugin, index) => samePlugin(plugin, right.plugins[index]!)) &&
    left.skills.length === right.skills.length &&
    left.skills.every((skill, index) => sameSkill(skill, right.skills[index]!))
  );
}

function summary(extensionProfile: ResolvedExtensionProfile): string {
  const skills =
    extensionProfile.counts.standalone_skills_active + extensionProfile.counts.plugin_skills_active;
  return `${extensionProfile.counts.plugins_active} plugins ${glyph("separator")} ${skills} skills ${glyph("separator")} ${extensionProfile.counts.mcp_servers_active} MCP`;
}

function selectedDefinition(
  extensionProfile: ResolvedExtensionProfile,
): ExtensionProfileDefinition {
  return {
    schema_version: 1,
    description: `Clone of ${extensionProfile.id}`,
    plugins: extensionProfile.plugins.filter((plugin) => plugin.active).map((plugin) => plugin.ref),
    skills: extensionProfile.standalone_skills
      .filter((skill) => skill.active)
      .map((skill) => skill.ref),
  };
}

function countLabel(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

/** Guided discovery, installation, composition, capability review, and activation journey. */
export function ExtensionsHub(host: ViewHost, deps: ExtensionsHubDeps): JSX.Element {
  const dimensions = useTerminalDimensions();
  const editor = createFieldEditor(host.interaction, host.active);
  const [step, setStep] = createSignal<SetupStep>(0);
  const [picker, setPicker] = createSignal<CatalogPickerSpec | null>(null);
  const [draft, setDraft] = createSignal<ExtensionSetupDraft>();
  const [preview, setPreview] = createSignal<ExtensionProfileCompositionPreview>();
  const [busy, setBusy] = createSignal<string>();
  const [busyStartedAt, setBusyStartedAt] = createSignal<number>();
  const [busyEscapeMode, setBusyEscapeMode] = createSignal<"level" | "close">("level");
  const [failure, setFailure] = createSignal<string>();
  const [completion, setCompletion] = createSignal<SetupCompletion>();
  let reviewScroll: ScrollBoxRenderable | undefined;
  let applyScroll: ScrollBoxRenderable | undefined;
  let consumedInitial = false;
  let disposed = false;
  let draftGeneration = 0;
  let applyDetached = false;

  onCleanup(() => {
    disposed = true;
  });

  useSpinnerClock(() => busy() !== undefined && host.active());

  const replaceDraft = (next: ExtensionSetupDraft | undefined): void => {
    draftGeneration += 1;
    setDraft(next);
  };
  const beginBusy = (label: string, escapeMode: "level" | "close" = "level"): void => {
    setBusyStartedAt(Date.now());
    setBusyEscapeMode(escapeMode);
    setBusy(label);
  };
  const finishBusy = (): void => {
    setBusy(undefined);
    setBusyStartedAt(undefined);
    setBusyEscapeMode("level");
  };

  const report = (error: unknown): void => deps.notify(errorText(error), "warn");
  const selectedCount = (): number => {
    const definition = draft()?.definition;
    return (definition?.plugins.length ?? 0) + (definition?.skills.length ?? 0);
  };
  const selectionReadOnly = (): boolean => deps.current()?.selection_origin === "cli";
  const operationPending = createMemo(() => busy() !== undefined);
  const applyAllowed = (): boolean =>
    busy() === undefined && !deps.runActive() && !selectionReadOnly() && preview() !== undefined;

  const title = (): string => {
    if (step() === 0) return "Extensions";
    if (step() === 6) return "Extensions ready";
    const label = ["", "Scope", "Extension Profile", "Plugins and skills", "Capabilities", "Apply"][
      step()
    ];
    return `Extensions setup ${glyph("separator")} Step ${step()} of 5 ${glyph("separator")} ${label}`;
  };

  const resetSetup = (): void => {
    setPicker(null);
    replaceDraft(undefined);
    setPreview(undefined);
    setCompletion(undefined);
    setFailure(undefined);
    setStep(0);
  };

  const draftFor = (
    view: ExtensionProfileDefinitionView,
    selectionScope: ExtensionProfileSelectionScope,
  ): ExtensionSetupDraft | undefined => {
    if (
      view.ref.scope === "builtin" ||
      view.definition === undefined ||
      view.revision === undefined
    ) {
      return undefined;
    }
    return {
      selectionScope,
      ref: { scope: view.ref.scope, name: view.ref.name },
      definition: view.definition,
      expectedRevision: view.revision,
      savedDefinition: view.definition,
    };
  };

  const setExistingDraft = (
    view: ExtensionProfileDefinitionView,
    selectionScope: ExtensionProfileSelectionScope,
  ): void => {
    const next = draftFor(view, selectionScope);
    if (next === undefined) {
      deps.notify(view.error ?? `${extensionProfileId(view.ref)} is not editable`, "warn");
      return;
    }
    replaceDraft(next);
    setStep(3);
    openExtensionPicker();
  };

  const beginNamedDraft = (
    scope: "global" | "workspace",
    selectionScope: ExtensionProfileSelectionScope,
    basis: ExtensionProfileDefinition,
  ): void => {
    setPicker(null);
    setStep(2);
    editor.start(`Step 2 of 5 ${glyph("separator")} ${scope} Extension Profile name`, "", (raw) => {
      const name = raw.trim();
      if (!NAME_RE.test(name)) {
        deps.notify("use 1-128 letters, numbers, dots, underscores or hyphens", "warn");
        openExtensionProfilePicker(selectionScope);
        return;
      }
      if (
        deps
          .definitions()
          .some((definition) => definition.ref.scope === scope && definition.ref.name === name)
      ) {
        deps.notify(`${scope}:${name} already exists`, "warn");
        openExtensionProfilePicker(selectionScope);
        return;
      }
      replaceDraft({
        selectionScope,
        ref: { scope, name },
        definition: basis,
        expectedRevision: null,
      });
      setStep(3);
      openExtensionPicker();
    });
  };

  const extensionProfileRows = (selectionScope: ExtensionProfileSelectionScope): CatalogRow[] => {
    const current = deps.current();
    const definitions = deps
      .definitions()
      .filter(
        (view) =>
          view.ref.scope !== "builtin" &&
          (selectionScope === "workspace" || view.ref.scope === "global"),
      )
      .map((view) => ({
        id: `existing:${view.ref.scope}:${view.ref.name}`,
        label: extensionProfileId(view.ref),
        haystack: `${extensionProfileId(view.ref)} ${view.definition?.description ?? ""}`,
        detail: view.error
          ? `unavailable ${glyph("separator")} ${view.error}`
          : `${view.definition?.plugins.length ?? 0} plugins ${glyph("separator")} ${view.definition?.skills.length ?? 0} skills`,
        added: current?.id === extensionProfileId(view.ref),
      }));
    const targetScopes: ("global" | "workspace")[] =
      selectionScope === "global" ? ["global"] : ["workspace", "global"];
    const cloneRows = targetScopes.flatMap((scope) => {
      if (current === undefined) return [];
      const basis = selectedDefinition(current);
      if (
        scope === "global" &&
        (basis.plugins.some((plugin) => plugin.scope === "workspace") ||
          basis.skills.some((skill) => skill.scope === "workspace"))
      ) {
        return [];
      }
      return [
        {
          id: `clone:${scope}`,
          label: `Clone active → ${scope}`,
          haystack: `clone customize current ${current.id} ${scope}`,
          detail: `${current.id} ${glyph("separator")} recommended ${glyph("separator")} starts with the active extensions`,
        },
      ];
    });
    const emptyRows = targetScopes.map((scope) => ({
      id: `empty:${scope}`,
      label: `New ${scope} Extension Profile`,
      haystack: `new empty ${scope} Extension Profile`,
      detail:
        scope === "workspace"
          ? "starts empty · shareable project definition; selection stays local"
          : "starts empty · reusable in every workspace",
    }));
    return [...cloneRows, ...definitions, ...emptyRows];
  };

  function openScopePicker(): void {
    setStep(1);
    setPicker({
      title: `Extensions setup ${glyph("separator")} Step 1 of 5 ${glyph("separator")} Scope`,
      rows: () => [
        {
          id: "workspace",
          label: "This workspace",
          haystack: "workspace local project",
          detail: "recommended · local selection; may use global and workspace inventory",
        },
        {
          id: "global",
          label: "Global default",
          haystack: "global default every workspace",
          detail: "used only where no workspace-local selection overrides it",
        },
      ],
      onPick: (id) => openExtensionProfilePicker(id as ExtensionProfileSelectionScope),
      onClose: resetSetup,
    });
  }

  function openExtensionProfilePicker(selectionScope: ExtensionProfileSelectionScope): void {
    setStep(2);
    setPicker({
      title: `Extensions setup ${glyph("separator")} Step 2 of 5 ${glyph("separator")} Extension Profile`,
      rows: () => extensionProfileRows(selectionScope),
      onPick: (choice) => {
        if (choice.startsWith("existing:")) {
          const [, scope, ...nameParts] = choice.split(":");
          const name = nameParts.join(":");
          const view = deps
            .definitions()
            .find((candidate) => candidate.ref.scope === scope && candidate.ref.name === name);
          if (view !== undefined) setExistingDraft(view, selectionScope);
          return;
        }
        const [kind, rawScope] = choice.split(":");
        const scope = rawScope as "global" | "workspace";
        const current = deps.current();
        const basis =
          kind === "clone" && current !== undefined
            ? selectedDefinition(current)
            : { schema_version: 1 as const, plugins: [], skills: [] };
        beginNamedDraft(scope, selectionScope, basis);
      },
      onClose: openScopePicker,
    });
  }

  const choiceMap = createMemo(() => {
    const setup = draft();
    const choices = new Map<string, ExtensionChoice>();
    if (setup === undefined) return choices;
    const installedPlugins = new Set<string>();
    for (const plugin of deps.inventory()?.plugins ?? []) {
      if (setup.ref.scope === "global" && plugin.ref.scope !== "global") continue;
      installedPlugins.add(pluginId(plugin.ref));
      choices.set(`plugin:${pluginId(plugin.ref)}`, { kind: "plugin", plugin });
    }
    for (const ref of setup.definition.plugins) {
      if (installedPlugins.has(pluginId(ref))) continue;
      choices.set(`plugin:${pluginId(ref)}`, {
        kind: "plugin",
        plugin: {
          ref,
          active: false,
          installed: false,
          valid: false,
          agents: [],
          skills: [],
          mcp_servers: [],
          hooks: { total: 0 },
          capability_executables: [],
          error: "selected installation is missing",
        },
      });
    }
    const discoveredSkills = new Set<string>();
    for (const skill of deps.inventory()?.standalone_skills ?? []) {
      if (setup.ref.scope === "global" && skill.ref.scope !== "user") continue;
      discoveredSkills.add(skillId(skill.ref));
      choices.set(`skill:${skillId(skill.ref)}`, { kind: "skill", skill });
    }
    for (const ref of setup.definition.skills) {
      if (discoveredSkills.has(skillId(ref))) continue;
      choices.set(`skill:${skillId(ref)}`, {
        kind: "skill",
        skill: {
          ref,
          active: false,
          found: false,
          error: "selected skill is missing",
        },
      });
    }
    for (const listing of deps.listings()) {
      if (listing.installed) continue;
      choices.set(`listing:${listing.marketplace}:${listing.name}`, { kind: "listing", listing });
    }
    return choices;
  });

  const extensionRows = (): CatalogRow[] => {
    const setup = draft();
    if (setup === undefined) return [];
    const rows = [...choiceMap()].map(([id, choice]) => {
      if (choice.kind === "plugin") {
        const plugin = choice.plugin;
        const active = setup.definition.plugins.some((ref) => samePlugin(ref, plugin.ref));
        const capabilities = [
          countLabel(plugin.agents.length, "agent"),
          countLabel(plugin.skills.length, "skill"),
          countLabel(plugin.mcp_servers.length, "MCP"),
          countLabel(plugin.hooks.total, "hook"),
        ].filter((label) => !label.startsWith("0 "));
        return {
          id,
          label: plugin.ref.name,
          haystack: `${pluginId(plugin.ref)} ${plugin.agents.join(" ")} ${plugin.skills.join(" ")} ${plugin.mcp_servers.join(" ")}`,
          detail: `${plugin.valid ? "installed" : "invalid"} ${glyph("separator")} ${plugin.ref.scope}/${plugin.ref.source}${capabilities.length > 0 ? ` ${glyph("separator")} ${capabilities.join(` ${glyph("separator")} `)}` : ""}`,
          added: active,
        };
      }
      if (choice.kind === "skill") {
        const skill = choice.skill;
        return {
          id,
          label: `/${skill.ref.name}`,
          haystack: `${skillId(skill.ref)} ${skill.description ?? ""}`,
          detail: `${skill.found ? "standalone skill" : "missing selected skill"} ${glyph("separator")} ${skill.ref.scope}/${skill.ref.source}${skill.description ? ` ${glyph("separator")} ${skill.description}` : ""}`,
          added: setup.definition.skills.some((ref) => sameSkill(ref, skill.ref)),
        };
      }
      const listing = choice.listing;
      return {
        id,
        label: listing.displayName ?? listing.name,
        haystack: `${listing.name} ${listing.displayName ?? ""} ${listing.description} ${listing.category ?? ""} ${listing.marketplace}`,
        detail: `${listing.installable ? "marketplace · install" : "unavailable"} ${glyph("separator")} ${listing.marketplace}${listing.category ? ` ${glyph("separator")} ${listing.category}` : ""}`,
      };
    });
    const rank = (row: CatalogRow): number => {
      if (row.added) return 0;
      if (row.id.startsWith("plugin:")) return 1;
      if (row.id.startsWith("skill:")) return 2;
      return 3;
    };
    return [
      {
        id: "setup:continue",
        label: "Continue to capability review",
        haystack: "continue next review capabilities selected extensions",
        detail: `${countLabel(selectedCount(), "extension")} selected`,
        action: true,
      },
      ...rows.sort(
        (left, right) =>
          rank(left) - rank(right) ||
          left.label.localeCompare(right.label) ||
          left.id.localeCompare(right.id),
      ),
    ];
  };

  const stagePlugin = (ref: ExtensionProfilePluginRef): void => {
    const setup = draft();
    if (setup === undefined) return;
    const selected = setup.definition.plugins.find((plugin) => samePlugin(plugin, ref));
    if (selected !== undefined) {
      setDraft({
        ...setup,
        definition: {
          ...setup.definition,
          plugins: setup.definition.plugins.filter((plugin) => !samePlugin(plugin, ref)),
        },
      });
      return;
    }
    const replaced = setup.definition.plugins.find((plugin) => plugin.name === ref.name);
    setDraft({
      ...setup,
      definition: {
        ...setup.definition,
        plugins: [...setup.definition.plugins.filter((plugin) => plugin.name !== ref.name), ref],
      },
    });
    if (replaced !== undefined) {
      deps.notify(`replaced ${pluginId(replaced)} with ${pluginId(ref)}`);
    }
  };

  const stageSkill = (ref: ExtensionProfileSkillRef): void => {
    const setup = draft();
    if (setup === undefined) return;
    const selected = setup.definition.skills.find((skill) => sameSkill(skill, ref));
    if (selected !== undefined) {
      setDraft({
        ...setup,
        definition: {
          ...setup.definition,
          skills: setup.definition.skills.filter((skill) => !sameSkill(skill, ref)),
        },
      });
      return;
    }
    const replaced = setup.definition.skills.find((skill) => skill.name === ref.name);
    setDraft({
      ...setup,
      definition: {
        ...setup.definition,
        skills: [...setup.definition.skills.filter((skill) => skill.name !== ref.name), ref],
      },
    });
    if (replaced !== undefined) deps.notify(`replaced ${skillId(replaced)} with ${skillId(ref)}`);
  };

  const installAndStage = (listing: MarketplaceListing, source: "agents" | "clarvis"): void => {
    if (busy() !== undefined) return;
    const ownerGeneration = draftGeneration;
    setPicker(null);
    beginBusy(`Installing ${listing.name}`);
    detachObserved(
      "extensions_setup_install",
      async () => {
        const installed = await deps.install(listing, source);
        if (!disposed) setBusy("Refreshing installed extensions");
        await deps.refresh(true);
        const staged = !disposed && ownerGeneration === draftGeneration && draft() !== undefined;
        if (staged) {
          stagePlugin({
            scope: installed.scope,
            source: installed.source,
            name: installed.name,
          });
        }
        deps.notify(
          staged
            ? `installed ${installed.scope}/${installed.source}/${installed.name}; staged, not active until Step 5`
            : `installed ${installed.scope}/${installed.source}/${installed.name}; setup was left before staging`,
          "success",
        );
        if (!disposed) {
          finishBusy();
          if (staged) openExtensionPicker();
        }
      },
      (error) => {
        if (!disposed) finishBusy();
        report(error);
        if (!disposed && ownerGeneration === draftGeneration) openExtensionPicker();
      },
    );
  };

  const openInstallTarget = (listing: MarketplaceListing): void => {
    if (!listing.installable) {
      deps.notify(listing.notes[0] ?? `${listing.name} cannot be installed by this host`, "warn");
      return;
    }
    setPicker({
      title: `Extensions setup ${glyph("separator")} Step 3 of 5 ${glyph("separator")} Install location`,
      rows: () => [
        {
          id: "agents",
          label: `${AGENTS_DIR}/${AGENTS_PLUGINS_DIR}`,
          haystack: "agents shared standard compatible",
          detail: "recommended · shared Agent Plugins convention",
        },
        {
          id: "clarvis",
          label: `${CLARVIS_DIR}/${AGENTS_PLUGINS_DIR}`,
          haystack: "clarvis native",
          detail: "Clarvis-native global inventory",
        },
      ],
      onPick: (source) => installAndStage(listing, source as "agents" | "clarvis"),
      onClose: openExtensionPicker,
    });
  };

  const chooseExtension = (id: string): void => {
    if (id === "setup:continue") {
      resolveReview();
      return;
    }
    const choice = choiceMap().get(id);
    if (choice === undefined) return;
    if (choice.kind === "plugin") {
      const selected = draft()?.definition.plugins.some((ref) =>
        samePlugin(ref, choice.plugin.ref),
      );
      if (!choice.plugin.valid && !selected) {
        deps.notify(choice.plugin.error ?? `${pluginId(choice.plugin.ref)} is invalid`, "warn");
        return;
      }
      stagePlugin(choice.plugin.ref);
      return;
    }
    if (choice.kind === "skill") {
      stageSkill(choice.skill.ref);
      return;
    }
    openInstallTarget(choice.listing);
  };

  function openExtensionPicker(): void {
    if (draft() === undefined) return;
    setStep(3);
    setPicker({
      title: `Extensions setup ${glyph("separator")} Step 3 of 5 ${glyph("separator")} Plugins and skills`,
      stayOpen: true,
      counter: selectedCount,
      counterLabel: "selected",
      rows: extensionRows,
      confirmLabel: (row) =>
        row?.id === "setup:continue"
          ? "continue"
          : row?.id.startsWith("listing:")
            ? "install"
            : row?.added
              ? "remove"
              : "add",
      onPick: chooseExtension,
      onClose: backFromExtensions,
      escLabel: "back",
      ...(deps.initialPlugin === undefined
        ? {}
        : { initialId: `plugin:${pluginId(deps.initialPlugin)}` }),
    });
  }

  const draftDirty = (): boolean => {
    const setup = draft();
    if (setup === undefined) return false;
    if (setup.expectedRevision === null || setup.savedDefinition === undefined) return true;
    return !sameDefinition(setup.definition, setup.savedDefinition);
  };

  const discardDraftAndGoBack = (selectionScope: ExtensionProfileSelectionScope): void => {
    setPicker(null);
    replaceDraft(undefined);
    setPreview(undefined);
    setFailure(undefined);
    openExtensionProfilePicker(selectionScope);
  };

  function backFromExtensions(): void {
    const setup = draft();
    if (setup === undefined) return;
    if (!draftDirty()) {
      discardDraftAndGoBack(setup.selectionScope);
      return;
    }
    setPicker(null);
    detachObserved("extensions_setup_discard_confirm", () =>
      host
        .confirm({
          message: `Unsaved Extension Profile changes ${glyph("emDash")} discard them?`,
          danger: true,
          detail: [extensionProfileId(setup.ref)],
          confirmLabel: "discard",
          cancelLabel: "keep editing",
        })
        .then((approved) => {
          if (approved) discardDraftAndGoBack(setup.selectionScope);
          else openExtensionPicker();
        }),
    );
  }

  function resolveReview(): void {
    const setup = draft();
    if (setup === undefined || busy() !== undefined) return;
    const ownerGeneration = draftGeneration;
    setPicker(null);
    setPreview(undefined);
    setFailure(undefined);
    setStep(4);
    beginBusy("Resolving exact capabilities");
    const input: ExtensionProfileCompositionInput = {
      ref: setup.ref,
      definition: setup.definition,
      expected_revision: setup.expectedRevision,
      selection_scope: setup.selectionScope,
    };
    detachObserved(
      "extensions_setup_preview",
      async () => {
        const result = await deps.extensionProfiles.previewComposition(input);
        if (disposed) return;
        if (ownerGeneration === draftGeneration) setPreview(result);
        finishBusy();
      },
      (error) => {
        if (!disposed) {
          finishBusy();
          if (ownerGeneration === draftGeneration) setFailure(errorText(error));
        }
        report(error);
      },
    );
  }

  const backToExtensions = (): void => {
    setPreview(undefined);
    setFailure(undefined);
    openExtensionPicker();
  };

  const apply = (): void => {
    const setup = draft();
    const reviewed = preview();
    if (setup === undefined || reviewed === undefined || !applyAllowed()) return;
    applyDetached = false;
    beginBusy("Applying reviewed snapshot", "close");
    setFailure(undefined);
    const input: ExtensionProfileCompositionInput = {
      ref: setup.ref,
      definition: setup.definition,
      expected_revision: setup.expectedRevision,
      selection_scope: setup.selectionScope,
    };
    detachObserved(
      "extensions_setup_apply",
      async () => {
        await deps.extensionProfiles.applyComposition(input, {
          preview_token: reviewed.token,
          ...(reviewed.requires_workspace_trust ? { approve_workspace: true } : {}),
        });
        if (!disposed && !applyDetached) setBusy("Reconnecting the kernel");
        const reconnect = await deps.reconnect();
        if (!disposed && !applyDetached) setBusy("Refreshing the resolved Extension Profile");
        await deps.refresh(true);
        if (!disposed) {
          if (!applyDetached) {
            setCompletion({ reconnect });
            setStep(6);
          }
          finishBusy();
        }
        deps.notify(
          reconnect.ok
            ? `${extensionProfileId(setup.ref)} is active for future runs`
            : `${extensionProfileId(setup.ref)} was saved; reconnect with /reconnect (${reconnect.message})`,
          reconnect.ok ? "success" : "warn",
        );
      },
      (error) => {
        if (!disposed) {
          finishBusy();
          if (!applyDetached) {
            setPreview(undefined);
            setFailure(errorText(error));
            setStep(4);
          }
        }
        report(error);
      },
    );
  };

  const begin = (): void => {
    if (deps.loading() || deps.loadError() !== undefined) return;
    replaceDraft(undefined);
    setPreview(undefined);
    setCompletion(undefined);
    setFailure(undefined);
    openScopePicker();
  };

  createEffect(() => {
    host.markDirty(step() >= 3 && step() <= 5 && draftDirty());
  });

  createEffect(() => {
    const initial = deps.initialExtensionProfile;
    deps.definitions();
    deps.inventory();
    if (consumedInitial || initial === undefined || deps.loading()) return;
    consumedInitial = true;
    if (initial.scope === "builtin") {
      openScopePicker();
      return;
    }
    const view = deps
      .definitions()
      .find(
        (candidate) => candidate.ref.scope === initial.scope && candidate.ref.name === initial.name,
      );
    const current = deps.current();
    const selectionScope: ExtensionProfileSelectionScope =
      current?.id === extensionProfileId(initial) && current.selection_origin === "global"
        ? "global"
        : "workspace";
    if (view === undefined || draftFor(view, selectionScope) === undefined) {
      openScopePicker();
      return;
    }
    setExistingDraft(view, selectionScope);
  });

  createEffect(() => {
    if (!host.active() || !operationPending()) return;
    const closesView = busyEscapeMode() === "close";
    const off = host.interaction.keymap.registerLayer({
      priority: LAYER.OVERLAY + 2,
      commands: closesView
        ? [
            uiCommand({
              id: "extensions.setup.operation.close",
              title: "Leave pending apply",
              description: "Close Extensions while apply and reconnect continue",
              category: "escape",
              surfaces: ["footer"],
              footerLabel: "close",
              hintPriority: 100,
              hintGroup: "escape",
              essential: true,
              run: () => {
                applyDetached = true;
                host.markDirty(false);
                host.close();
              },
            }),
          ]
        : [],
      bindings: [
        ...(closesView ? [{ key: "escape", cmd: "extensions.setup.operation.close" }] : []),
        { key: "return", cmd: () => {} },
      ],
    });
    onCleanup(off);
  });

  const spec = (): LevelSpec => {
    if (step() === 0) {
      return {
        verbs: [
          {
            id: "extensions.setup.begin",
            key: "return",
            label: "begin guided setup",
            run: begin,
            when: () => !deps.loading() && deps.loadError() === undefined,
            hintGroup: "primary",
            hintPriority: 100,
            essential: true,
          },
          {
            key: "e",
            label: "Extension Profiles",
            run: () => deps.openChild("extension-profiles.open"),
          },
          {
            key: "m",
            label: "Plugins and Marketplace",
            run: () => deps.openChild("marketplace.open"),
          },
          { key: "c", label: "MCP", run: () => deps.openChild("mcp.browse") },
          {
            key: "r",
            label: "refresh",
            run: () => detachObserved("extensions_setup_refresh", () => deps.refresh(true), report),
          },
        ],
        escape: { label: "close", run: () => host.close() },
      };
    }
    if (step() === 2 && picker() === null && editor.editing() === null) {
      return {
        verbs: [
          {
            key: "return",
            label: "choose Extension Profile",
            run: () => openExtensionProfilePicker(draft()?.selectionScope ?? "workspace"),
          },
        ],
        escape: { label: "back to scope", run: openScopePicker },
      };
    }
    if (step() === 3 && picker() === null && editor.editing() === null) {
      return {
        verbs: [{ key: "return", label: "choose extensions", run: openExtensionPicker }],
        escape: {
          label: "back",
          run: backFromExtensions,
        },
      };
    }
    if (step() === 4) {
      return {
        scroll: () => reviewScroll,
        verbs: [
          {
            id: "extensions.setup.review.continue",
            key: "return",
            label: "review activation delta",
            run: () => setStep(5),
            when: () => preview() !== undefined && busy() === undefined,
            hintGroup: "primary",
            hintPriority: 100,
            essential: true,
          },
          {
            key: "r",
            label: "resolve again",
            run: resolveReview,
            when: () => busy() === undefined,
          },
        ],
        escape: { label: "back", run: backToExtensions },
      };
    }
    if (step() === 5) {
      return {
        scroll: () => applyScroll,
        verbs: [
          {
            id: "extensions.setup.apply",
            key: "return",
            label: "apply and reconnect",
            run: apply,
            when: applyAllowed,
            hintGroup: "primary",
            hintPriority: 100,
            essential: true,
          },
        ],
        escape: { label: "back", run: () => setStep(4) },
      };
    }
    if (step() === 6) {
      return {
        verbs: [
          {
            key: "return",
            label: "configure another",
            run: begin,
            hintGroup: "primary",
            hintPriority: 100,
            essential: true,
          },
          {
            key: "e",
            label: "inspect Extension Profile",
            run: () => deps.openChild("extension-profiles.open"),
          },
        ],
        escape: { label: "close", run: () => host.close() },
      };
    }
    return {};
  };

  bindLevelKeys({
    host,
    editor,
    suspend: () => picker() !== null,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  const footerStatus = () => {
    const label = busy();
    if (label === undefined) return undefined;
    const startedAt = busyStartedAt();
    const running = tone("running", spinnerChar());
    const elapsed =
      startedAt === undefined
        ? ""
        : ` ${glyph("separator")} ${formatElapsed(tickNow() - startedAt)}`;
    return {
      glyph: running.glyph,
      glyphFg: running.fg,
      text: label + glyph("ellipsis") + elapsed,
      fg: tokens.muted,
    };
  };

  function setupIntro(): JSX.Element {
    const current = deps.current();
    const brokenSources = deps.sources().filter((source) => source.error !== undefined).length;
    return (
      <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <Show when={firstRunSplashFits(dimensions().width, dimensions().height - 8)}>
          <box flexShrink={0} paddingBottom={2}>
            <BrandBanner width={() => dimensions().width} />
          </box>
        </Show>
        <box flexDirection="column" alignItems="center" maxWidth={92}>
          <text fg={tokens.accent}>Build one exact extension snapshot</text>
          <text fg={tokens.fg} wrapMode="word">
            Discover, install, compose, review executable capabilities, then apply.
          </text>
          <Show when={current}>
            <text fg={tokens.muted} paddingTop={1} wrapMode="word">
              {`Active  ${current!.id} ${glyph("separator")} ${summary(current!)}`}
            </text>
          </Show>
          <text fg={tokens.muted} paddingTop={1}>
            Step 1 scope {glyph("arrowRight")} 2 Extension Profile {glyph("arrowRight")} 3
            extensions
          </text>
          <text fg={tokens.muted}>
            4 capabilities {glyph("arrowRight")} 5 exact delta and apply
          </text>
          <text fg={tokens.accent2} paddingTop={1}>
            Enter {glyph("arrowRight")} begin guided setup
          </text>
          <text fg={tokens.muted}>
            e {glyph("arrowRight")} Extension Profiles m {glyph("arrowRight")} Plugins and
            Marketplace c {glyph("arrowRight")} MCP
          </text>
          <Show when={brokenSources > 0}>
            <text
              fg={tokens.warn}
            >{`${glyph("warning")} ${brokenSources} marketplace source${brokenSources === 1 ? "" : "s"} unavailable`}</text>
          </Show>
          <Show when={deps.loadError() !== undefined}>
            <text fg={tokens.del} paddingTop={1} wrapMode="word">
              {`${glyph("warning")} ${deps.loadError()}`}
            </text>
            <text fg={tokens.accent2}>Press r to retry loading the extension inventory.</text>
          </Show>
        </box>
      </box>
    );
  }

  function waitingBody(): JSX.Element {
    return (
      <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <text fg={tokens.accent2}>
          {busy() === undefined ? "Choose from the open picker." : "Keeping your setup in place."}
        </text>
        <Show when={draft()}>
          <text fg={tokens.muted} paddingTop={1}>
            {`${extensionProfileId(draft()!.ref)} ${glyph("separator")} ${draft()!.definition.plugins.length} plugins ${glyph("separator")} ${draft()!.definition.skills.length} standalone skills`}
          </text>
        </Show>
      </box>
    );
  }

  function valueSection(label: string, values: readonly string[], fg = tokens.fg): JSX.Element {
    return (
      <>
        <SectionHeader label={`${label} (${values.length})`} />
        <Show when={values.length > 0} fallback={<text fg={tokens.muted}>none</text>}>
          <For each={values}>
            {(value) => (
              <text fg={fg} wrapMode="word">
                {value}
              </text>
            )}
          </For>
        </Show>
      </>
    );
  }

  function capabilityReview(): JSX.Element {
    const reviewed = preview();
    if (reviewed === undefined) {
      return (
        <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
          <Show
            when={busy() === undefined}
            fallback={<text fg={tokens.muted}>The exact draft remains unchanged.</text>}
          >
            <EmptyHint
              text="Capabilities could not be resolved"
              hint="Press r to retry or Escape to go back."
            />
          </Show>
          <Show when={failure() !== undefined}>
            <text fg={tokens.del}>{failure()}</text>
          </Show>
        </box>
      );
    }
    const extensionProfile = reviewed.authored;
    const plugins = extensionProfile.plugins;
    const agents = plugins.flatMap((plugin) =>
      plugin.agents.map((agent) => `${plugin.ref.name}:${agent}`),
    );
    const pluginSkills = plugins.flatMap((plugin) =>
      plugin.skills.map((skill) => `${plugin.ref.name}:/${skill}`),
    );
    const standalone = extensionProfile.standalone_skills.map((skill) => skillId(skill.ref));
    const mcp = plugins.flatMap((plugin) => plugin.mcp_servers);
    const hooks = plugins
      .filter((plugin) => plugin.hooks.total > 0)
      .map((plugin) => `${pluginId(plugin.ref)} ${plugin.hooks.total} hooks`);
    const executables = plugins.flatMap((plugin) =>
      plugin.capability_executables.map((capability) => `${plugin.ref.name}:${capability}`),
    );
    return (
      <>
        <text fg={tokens.accent2} flexShrink={0} wrapMode="word">
          Enter continues to the exact activation delta. Escape goes back.
        </text>
        <scrollbox
          ref={(element: ScrollBoxRenderable) => (reviewScroll = element)}
          flexGrow={1}
          minHeight={0}
          verticalScrollbarOptions={scrollbarOptions()}
        >
          <box flexDirection="column">
            <text fg={tokens.accent} wrapMode="word">
              <b>{extensionProfile.id}</b>
            </text>
            <text fg={extensionProfile.status === "ready" ? tokens.add : tokens.warn}>
              {`${tone(extensionProfile.status === "ready" ? "ok" : "warn").glyph} ${extensionProfile.status} ${glyph("separator")} ${summary(extensionProfile)}`}
            </text>
            <Show when={mcp.length + hooks.length + executables.length > 0}>
              <text fg={tokens.warn} wrapMode="word" paddingTop={1}>
                {`${glyph("warning")} This draft carries executable capabilities. Selecting each plugin approves its complete contribution.`}
              </text>
            </Show>
            {valueSection(
              "Plugins",
              plugins.map((plugin) => pluginId(plugin.ref)),
            )}
            {valueSection("Agents", agents)}
            {valueSection("Plugin skills", pluginSkills)}
            {valueSection("Standalone skills", standalone)}
            {valueSection("MCP servers", mcp, tokens.warn)}
            {valueSection("Hooks", hooks, tokens.warn)}
            {valueSection("Capability executables", executables, tokens.warn)}
            <Show when={extensionProfile.issues.length > 0}>
              <SectionHeader label={`Issues (${extensionProfile.issues.length})`} />
              <For each={extensionProfile.issues}>
                {(issue) => (
                  <text fg={tokens.del} wrapMode="word">{`${issue.code}: ${issue.message}`}</text>
                )}
              </For>
            </Show>
          </box>
        </scrollbox>
      </>
    );
  }

  function applyReview(): JSX.Element {
    const reviewed = preview();
    if (reviewed === undefined)
      return <EmptyHint text="Review expired" hint="Press Escape, then resolve the draft again." />;
    const delta = reviewed.delta;
    return (
      <box flexDirection="column" flexGrow={1} minHeight={0}>
        <text fg={tokens.accent2} flexShrink={0} wrapMode="word">
          {busy() === undefined
            ? "Enter writes this definition and selection, then reconnects. Escape returns."
            : "The reviewed delta stays pinned while the footer reports progress."}
        </text>
        <Show when={deps.runActive()}>
          <text fg={tokens.warn} flexShrink={0}>
            Finish the active run before applying.
          </text>
        </Show>
        <Show when={selectionReadOnly()}>
          <text fg={tokens.warn} flexShrink={0} wrapMode="word">
            Restart without --extension-profile before changing a persisted Extension Profile
            selection.
          </text>
        </Show>
        <scrollbox
          ref={(element: ScrollBoxRenderable) => (applyScroll = element)}
          flexGrow={1}
          minHeight={0}
          verticalScrollbarOptions={scrollbarOptions()}
        >
          <box flexDirection="column">
            <text fg={tokens.accent} wrapMode="word">
              <b>{`${reviewed.current.id} ${glyph("arrowRight")} ${reviewed.target.id}`}</b>
            </text>
            <text fg={tokens.muted} wrapMode="word">
              {`Write ${reviewed.authored.id} as the ${draft()!.selectionScope} selection`}
            </text>
            <Show when={reviewed.authored.id !== reviewed.target.id}>
              <text fg={tokens.warn} wrapMode="word">
                {`${glyph("warning")} A workspace-local selection keeps ${reviewed.target.id} effective here; only the global default changes.`}
              </text>
            </Show>
            {valueSection("Plugins entering", delta.plugins_entering.map(pluginId), tokens.add)}
            {valueSection("Plugins leaving", delta.plugins_leaving.map(pluginId), tokens.del)}
            {valueSection("Skills entering", delta.skills_entering, tokens.add)}
            {valueSection("Skills leaving", delta.skills_leaving, tokens.del)}
            {valueSection("MCP servers entering", delta.mcp_servers_entering, tokens.warn)}
            {valueSection("MCP servers leaving", delta.mcp_servers_leaving, tokens.del)}
            {valueSection(
              "Hooks entering",
              delta.hooks_entering.map((hook) => `${pluginId(hook.plugin)} ${hook.total} hooks`),
              tokens.warn,
            )}
            {valueSection(
              "Hooks leaving",
              delta.hooks_leaving.map((hook) => `${pluginId(hook.plugin)} ${hook.total} hooks`),
              tokens.del,
            )}
            <Show when={reviewed.requires_workspace_trust}>
              <SectionHeader label="Workspace trust" />
              <text fg={tokens.warn} wrapMode="word">
                {`Apply approves repository-owned plugins in ${reviewed.target.id} at ${reviewed.target.fingerprint}. Global installed plugins already carry installation consent.`}
              </text>
            </Show>
          </box>
        </scrollbox>
      </box>
    );
  }

  function doneBody(): JSX.Element {
    const current = deps.current();
    const result = completion();
    return (
      <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <text fg={result?.reconnect.ok ? tokens.add : tokens.warn}>
          {`${tone(result?.reconnect.ok ? "ok" : "warn").glyph} ${result?.reconnect.ok ? "Extensions ready" : "Extension Profile saved"}`}
        </text>
        <Show when={current}>
          <text fg={tokens.accent} paddingTop={1}>
            <b>{current!.id}</b>
          </text>
          <text fg={tokens.fg}>{summary(current!)}</text>
          <text fg={tokens.muted} wrapMode="word">{`fingerprint ${current!.fingerprint}`}</text>
          <Show when={current!.issues.length > 0}>
            <text
              fg={tokens.warn}
            >{`${current!.issues.length} issue${current!.issues.length === 1 ? "" : "s"} require${current!.issues.length === 1 ? "s" : ""} attention`}</text>
          </Show>
        </Show>
        <Show when={result && !result.reconnect.ok}>
          <text fg={tokens.warn} paddingTop={1} wrapMode="word">
            {`The persisted selection takes effect after /reconnect: ${result!.reconnect.message}`}
          </text>
        </Show>
        <text fg={tokens.accent2} paddingTop={1}>
          Enter {glyph("arrowRight")} configure another Extension Profile
        </text>
      </box>
    );
  }

  function body(): JSX.Element {
    if (step() === 0) return setupIntro();
    if (step() <= 3) return waitingBody();
    if (step() === 4) return capabilityReview();
    if (step() === 5) return applyReview();
    return doneBody();
  }

  return (
    <LevelHost
      host={host}
      editor={editor}
      picker={picker}
      footerStatus={footerStatus}
      levels={[{ title, body }]}
    />
  );
}
