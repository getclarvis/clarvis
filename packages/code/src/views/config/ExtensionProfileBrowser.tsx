import type { JSX } from "solid-js";
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import type {
  ExtensionProfileDefinitionView,
  ExtensionProfileInventory,
  ExtensionProfilePreview,
  ExtensionProfileRef,
  ExtensionProfileService,
  PluginRef,
  ResolvedExtensionProfile,
} from "@clarvis/protocol";
import { errorText } from "../../adapters/errors.ts";
import { detachObserved } from "../../core/tasks.ts";
import { fuzzyFilter } from "../../core/fuzzy.ts";
import type { ViewHost } from "../../keys/commands.ts";
import { glyph } from "../../theme/glyphs.ts";
import { tokens } from "../../theme/tokens.ts";
import { tone } from "../../theme/tone.ts";
import { scrollbarOptions } from "../../theme/surfaces.ts";
import { clampListIndex } from "../../ui/patterns/list-navigation.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { StableWindowedList } from "../../ui/patterns/windowed-list.tsx";
import { formatElapsed, spinnerChar, tickNow, useSpinnerClock } from "../spinner.ts";
import {
  bindLevelKeys,
  createFieldEditor,
  EmptyHint,
  LoadingHint,
  SectionHeader,
  SelectableRow,
  ViewFrame,
} from "./view-host.tsx";

/** Host actions used by the Extension Profile control plane. */
export interface ExtensionProfileBrowserDeps {
  extensionProfiles: ExtensionProfileService;
  reconnect: () => Promise<{ ok: boolean; message: string }>;
  runActive: () => boolean;
  notify: (message: string, tone?: "success" | "warn" | "error") => void;
  configure: (ref?: ExtensionProfileRef) => void;
}

type PendingPreview =
  | {
      kind: "select";
      scope: "global" | "workspace";
      ref: ExtensionProfileRef;
      preview: ExtensionProfilePreview;
    }
  | {
      kind: "clear";
      scope: "global" | "workspace";
      preview: ExtensionProfilePreview;
    };

function id(ref: ExtensionProfileRef): string {
  return `${ref.scope}:${ref.name}`;
}

function pluginId(ref: PluginRef): string {
  return `${ref.scope}/${ref.source}/${ref.name}`;
}

function definitionHaystack(extensionProfile: ExtensionProfileDefinitionView): string {
  return [
    id(extensionProfile.ref),
    extensionProfile.definition?.description,
    extensionProfile.definition?.plugins.map(pluginId).join(" "),
    extensionProfile.definition?.skills
      .map((skill) => `${skill.scope}/${skill.source}/${skill.name}`)
      .join(" "),
    extensionProfile.error,
  ]
    .filter(Boolean)
    .join(" ");
}

function extensionProfileSummary(
  extensionProfile: ResolvedExtensionProfile,
  inventory: ExtensionProfileInventory | undefined,
): string {
  const counts = extensionProfile.counts;
  const skills = counts.standalone_skills_active + counts.plugin_skills_active;
  const discovered =
    inventory === undefined
      ? "…"
      : inventory.standalone_skills.length +
        inventory.plugins.reduce((total, plugin) => total + plugin.skills.length, 0);
  const installed = inventory === undefined ? "…" : inventory.plugins.length;
  return `${counts.plugins_active}/${installed} plugins ${glyph("separator")} ${skills}/${discovered} skills ${glyph("separator")} ${counts.mcp_servers_active} MCP`;
}

function pendingMessage(action: PendingPreview): string {
  if (action.kind === "select")
    return `Review before selecting ${id(action.ref)} for ${action.scope}.`;
  return `Review before clearing the ${action.scope} selection.`;
}

/** Browse, diagnose, configure, preview and select Extension Profiles. */
export function ExtensionProfileBrowser(
  host: ViewHost,
  deps: ExtensionProfileBrowserDeps,
): JSX.Element {
  const dimensions = useTerminalDimensions();
  const editor = createFieldEditor(host.interaction, host.active);
  const [definitions, setDefinitions] = createSignal<ExtensionProfileDefinitionView[]>([]);
  const [current, setCurrent] = createSignal<ResolvedExtensionProfile>();
  const [inventory, setInventory] = createSignal<ExtensionProfileInventory>();
  const [detail, setDetail] = createSignal<ResolvedExtensionProfile>();
  const [term, setTerm] = createSignal("");
  const [sel, setSel] = createSignal(0);
  const [busy, setBusy] = createSignal<string>();
  const [busyStartedAt, setBusyStartedAt] = createSignal<number>();
  const [loadError, setLoadError] = createSignal<string>();
  const [detailOpen, setDetailOpen] = createSignal(false);
  const [pending, setPending] = createSignal<PendingPreview>();
  let detailScroll: ScrollBoxRenderable | undefined;
  let previewScroll: ScrollBoxRenderable | undefined;
  let detailEpoch = 0;

  const rows = createMemo(() => {
    const value = term().trim();
    return value === "" ? definitions() : fuzzyFilter(definitions(), value, definitionHaystack);
  });
  const selected = (): ExtensionProfileDefinitionView | undefined =>
    rows()[clampListIndex(sel(), rows().length)];
  const selectionMutable = (): boolean => current()?.selection_origin !== "cli";
  const maxLines = (): number => Math.max(1, dimensions().height - 10 - (loadError() ? 2 : 0));

  useSpinnerClock(() => busy() !== undefined && host.active());

  const report = (error: unknown): void => deps.notify(errorText(error), "warn");

  const reload = async (): Promise<void> => {
    try {
      const [nextDefinitions, nextCurrent, nextInventory] = await Promise.all([
        deps.extensionProfiles.list(),
        deps.extensionProfiles.current(),
        deps.extensionProfiles.inventory(),
      ]);
      setDefinitions(nextDefinitions);
      setCurrent(nextCurrent);
      setInventory(nextInventory);
      setSel((index) => clampListIndex(index, nextDefinitions.length));
      setLoadError(undefined);
    } catch (error) {
      setLoadError(errorText(error));
      throw error;
    }
  };

  const act = (name: string, label: string, task: () => Promise<void>): void => {
    if (busy() !== undefined) return;
    setBusyStartedAt(Date.now());
    setBusy(label);
    detachObserved(
      name,
      async () => {
        try {
          await task();
        } finally {
          setBusy(undefined);
          setBusyStartedAt(undefined);
        }
      },
      report,
    );
  };

  const previewSelection = (scope: "global" | "workspace"): void => {
    const target = selected();
    if (target === undefined || deps.runActive() || !selectionMutable()) return;
    act("extension_profile_preview_select", "Preparing activation preview", async () => {
      const preview = await deps.extensionProfiles.preview(target.ref, { selection_scope: scope });
      setPending({ kind: "select", scope, ref: target.ref, preview });
    });
  };

  const previewClear = (scope: "global" | "workspace"): void => {
    if (deps.runActive() || !selectionMutable()) return;
    act(`extension_profile_preview_clear_${scope}`, "Preparing selection preview", async () => {
      setPending({
        kind: "clear",
        scope,
        preview: await deps.extensionProfiles.previewClear(scope),
      });
    });
  };

  const applyPending = (): void => {
    const action = pending();
    if (action === undefined || deps.runActive()) return;
    setPending(undefined);
    act("extension_profile_apply_preview", "Applying Extension Profile selection", async () => {
      if (action.kind === "select") {
        await deps.extensionProfiles.select(action.ref, {
          selection_scope: action.scope,
          preview_token: action.preview.token,
          ...(action.preview.requires_workspace_trust ? { approve_workspace: true } : {}),
        });
      } else {
        await deps.extensionProfiles.clearSelection(action.scope, {
          preview_token: action.preview.token,
        });
      }
      setBusy("Reconnecting the kernel");
      const reconnected = await deps.reconnect();
      setBusy("Refreshing Extension Profiles");
      await reload();
      const actionLabel =
        action.kind === "select"
          ? `${id(action.ref)} is active for new runs`
          : `${action.scope === "workspace" ? "workspace selection" : "global default"} cleared`;
      deps.notify(
        reconnected.ok
          ? actionLabel
          : `${actionLabel}; reload with /reconnect reload (${reconnected.message})`,
        reconnected.ok ? "success" : "warn",
      );
    });
  };

  const openClearSelection = (): void =>
    editor.startPick(
      "clear selection",
      [
        {
          label: "workspace selection",
          value: "workspace",
          detail: "fall back to the global default or builtin",
        },
        {
          label: "global default",
          value: "global",
          detail: "fall back to builtin:default when no workspace choice exists",
        },
      ],
      (scope) => previewClear(scope as "global" | "workspace"),
    );

  const deleteSelected = (): void => {
    const target = selected();
    if (
      target === undefined ||
      target.immutable ||
      target.revision === undefined ||
      current()?.id === id(target.ref) ||
      busy() !== undefined
    )
      return;
    detachObserved("extension_profile_delete_confirm", () =>
      host
        .confirm({
          message: `Delete ${id(target.ref)}?`,
          danger: true,
          detail: [
            "The definition file will be removed. Installed plugins and skills stay intact.",
          ],
          confirmLabel: "delete",
          cancelLabel: "keep",
        })
        .then((approved) => {
          if (!approved) return;
          act("extension_profile_delete", `Deleting ${id(target.ref)}`, async () => {
            await deps.extensionProfiles.delete(
              target.ref as { scope: "global" | "workspace"; name: string },
              {
                expected_revision: target.revision!,
              },
            );
            setDetailOpen(false);
            await reload();
            deps.notify(`deleted ${id(target.ref)}`, "success");
          });
        }),
    );
  };

  createEffect(() => {
    term();
    setSel(0);
    setDetailOpen(false);
  });

  createEffect(() => {
    const ref = selected()?.ref;
    if (ref === undefined) {
      setDetail(undefined);
      return;
    }
    const epoch = ++detailEpoch;
    detachObserved(
      "extension_profile_detail",
      async () => {
        const resolved = await deps.extensionProfiles.get(ref);
        if (epoch === detailEpoch) setDetail(resolved);
      },
      report,
    );
  });
  onMount(() => act("extension_profiles_reload", "Loading Extension Profiles", reload));

  const spec = (): LevelSpec => {
    if (pending() !== undefined) {
      return {
        scroll: () => previewScroll,
        verbs: [
          {
            id: "extension_profile.preview.apply",
            key: "y",
            label: "apply and reconnect",
            run: applyPending,
            when: () => busy() === undefined && !deps.runActive(),
            hintGroup: "primary",
            hintPriority: 100,
            essential: true,
          },
          {
            id: "extension_profile.preview.cancel",
            key: "n",
            label: "keep current",
            run: () => setPending(undefined),
            hintGroup: "escape",
            hintPriority: 95,
            essential: true,
          },
        ],
        escape: { label: "keep current", run: () => setPending(undefined) },
      };
    }
    if (detailOpen()) {
      return {
        scroll: () => detailScroll,
        verbs: [
          {
            key: "e",
            label:
              selected()?.ref.scope === "builtin" ? "customize a clone" : "configure extensions",
            run: () => deps.configure(selected()?.ref),
            when: () => selected() !== undefined && busy() === undefined,
          },
          {
            key: "d",
            label: "delete Extension Profile",
            run: deleteSelected,
            when: () =>
              selected()?.immutable === false &&
              selected()?.revision !== undefined &&
              current()?.id !== id(selected()!.ref) &&
              busy() === undefined,
          },
        ],
        escape: { label: "back to Extension Profiles", run: () => setDetailOpen(false) },
      };
    }
    return {
      nav: {
        count: () => rows().length,
        index: sel,
        setIndex: setSel,
        lettersNav: false,
        activate: {
          label: "details",
          run: () => setDetailOpen(true),
          when: () => selected() !== undefined,
        },
      },
      verbs: [
        {
          id: "extension_profile.search",
          key: "/",
          label: "search",
          run: () =>
            editor.start("search Extension Profiles", term(), setTerm, { alwaysCommit: true }),
          hintGroup: "navigation",
          hintPriority: 75,
        },
        {
          key: "r",
          label: "refresh",
          run: () => act("extension_profiles_reload", "Refreshing Extension Profiles", reload),
        },
        {
          key: "w",
          label: "use in workspace",
          when: () =>
            selected() !== undefined &&
            !deps.runActive() &&
            busy() === undefined &&
            selectionMutable(),
          run: () => previewSelection("workspace"),
        },
        {
          key: "g",
          label: "set global default",
          when: () =>
            selected()?.ref.scope !== "workspace" &&
            !deps.runActive() &&
            busy() === undefined &&
            selectionMutable(),
          run: () => previewSelection("global"),
        },
        {
          key: "n",
          label: "new guided Extension Profile",
          when: () => busy() === undefined,
          run: () => deps.configure(),
        },
        {
          key: "e",
          label: "configure extensions",
          when: () => selected() !== undefined && busy() === undefined,
          run: () => deps.configure(selected()?.ref),
        },
        {
          key: "x",
          label: "clear selection",
          when: () => !deps.runActive() && busy() === undefined && selectionMutable(),
          run: openClearSelection,
        },
        {
          key: "d",
          label: "delete Extension Profile",
          when: () =>
            selected()?.immutable === false &&
            selected()?.revision !== undefined &&
            current()?.id !== id(selected()!.ref) &&
            busy() === undefined,
          run: deleteSelected,
        },
      ],
    };
  };

  bindLevelKeys({
    host,
    editor,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  const onWheel = (event: { scroll?: { direction: string; delta: number } }): void => {
    const scroll = event.scroll;
    if (scroll?.direction !== "up" && scroll?.direction !== "down") return;
    const delta = Math.max(1, Math.trunc(scroll.delta)) * (scroll.direction === "up" ? -1 : 1);
    setSel((currentIndex) => clampListIndex(currentIndex + delta, rows().length));
  };

  const footerStatus = () => {
    const label = busy();
    if (label === undefined) return undefined;
    const running = tone("running", spinnerChar());
    const startedAt = busyStartedAt();
    return {
      glyph: running.glyph,
      glyphFg: running.fg,
      text:
        label +
        glyph("ellipsis") +
        (startedAt === undefined
          ? ""
          : ` ${glyph("separator")} ${formatElapsed(tickNow() - startedAt)}`),
      fg: tokens.muted,
    };
  };

  function list(): JSX.Element {
    return (
      <box flexDirection="column" flexGrow={1} minHeight={0} onMouseScroll={onWheel}>
        <Show when={rows().length > 0}>
          <StableWindowedList
            items={rows()}
            index={clampListIndex(sel(), rows().length)}
            maxLines={maxLines()}
            slotCount={36}
            above={(overflow) => (
              <text
                visible={overflow.visible()}
                fg={tokens.muted}
              >{`  ${glyph("arrowUp")} ${overflow.count()} more`}</text>
            )}
            row={(slot) => {
              const extensionProfile = slot.item;
              const active = (): boolean =>
                extensionProfile() !== undefined && current()?.id === id(extensionProfile()!.ref);
              return (
                <SelectableRow selected={slot.selected()} visible={slot.visible()}>
                  <span style={{ fg: active() ? tone("ok").fg : tokens.muted }}>
                    {`${active() ? tone("ok").glyph : " "} `}
                  </span>
                  <span style={{ fg: tokens.fg }}>
                    {extensionProfile() === undefined ? "" : id(extensionProfile()!.ref)}
                  </span>
                  <span style={{ fg: extensionProfile()?.error ? tokens.del : tokens.muted }}>
                    {extensionProfile() === undefined
                      ? ""
                      : `${extensionProfile()!.immutable ? "  builtin" : ""}${extensionProfile()!.error ? "  invalid" : ""}`}
                  </span>
                </SelectableRow>
              );
            }}
            below={(overflow) => (
              <text
                visible={overflow.visible()}
                fg={tokens.muted}
              >{`  ${glyph("arrowDown")} ${overflow.count()} more`}</text>
            )}
          />
        </Show>
        <Show when={rows().length === 0}>
          <EmptyHint
            text={
              busy()
                ? "Loading Extension Profiles"
                : loadError()
                  ? "Extension Profile catalog unavailable"
                  : term()
                    ? `No matches for "${term()}"`
                    : "No Extension Profiles found"
            }
            hint={
              loadError()
                ? "Press r to retry."
                : term()
                  ? "Press / and submit an empty search to clear."
                  : undefined
            }
          />
        </Show>
      </box>
    );
  }

  function compactPreview(): JSX.Element {
    const extensionProfile = detail();
    if (extensionProfile === undefined) return <LoadingHint text="Resolving Extension Profile" />;
    const state = tone(
      extensionProfile.status === "ready"
        ? "ok"
        : extensionProfile.status === "degraded"
          ? "warn"
          : "error",
    );
    return (
      <box flexDirection="column" paddingLeft={1} overflow="hidden">
        <text fg={tokens.accent} wrapMode="word">
          <b>{extensionProfile.id}</b>
        </text>
        <Show when={extensionProfile.description}>
          <text fg={tokens.fg} wrapMode="word">
            {extensionProfile.description}
          </text>
        </Show>
        <text fg={state.fg} paddingTop={1}>{`${state.glyph} ${extensionProfile.status}`}</text>
        <text fg={tokens.muted} wrapMode="word">
          {extensionProfileSummary(extensionProfile, inventory())}
        </text>
        <text fg={tokens.accent2} wrapMode="word">
          Enter opens the full snapshot. e configures it step by step. w/g previews activation.
        </text>
      </box>
    );
  }

  function fullDetail(): JSX.Element {
    const extensionProfile = detail();
    if (extensionProfile === undefined) return <LoadingHint text="Resolving Extension Profile" />;
    const counts = extensionProfile.counts;
    const catalog = inventory();
    const installed = catalog?.plugins.length ?? "…";
    const discovered =
      catalog === undefined
        ? "…"
        : catalog.standalone_skills.length +
          catalog.plugins.reduce((total, plugin) => total + plugin.skills.length, 0);
    const state = tone(
      extensionProfile.status === "ready"
        ? "ok"
        : extensionProfile.status === "degraded"
          ? "warn"
          : "error",
    );
    return (
      <box flexDirection="column">
        <text fg={tokens.accent} wrapMode="word">
          <b>{extensionProfile.id}</b>
        </text>
        <Show when={extensionProfile.description}>
          <text fg={tokens.fg} wrapMode="word">
            {extensionProfile.description}
          </text>
        </Show>
        <SectionHeader label="Overview" />
        <text fg={state.fg}>{`${state.glyph} ${extensionProfile.status}`}</text>
        <text fg={tokens.muted}>{`selected by  ${extensionProfile.selection_origin}`}</text>
        <text
          fg={tokens.fg}
        >{`plugins      ${counts.plugins_active} active / ${installed} installed`}</text>
        <text
          fg={tokens.fg}
        >{`skills       ${counts.standalone_skills_active + counts.plugin_skills_active} active / ${discovered} discovered`}</text>
        <text fg={tokens.muted}>{`MCP servers  ${counts.mcp_servers_active}`}</text>
        <text
          fg={tokens.muted}
        >{`hooks        ${counts.hooks_declared} active with selected plugins`}</text>
        <SectionHeader label="Plugins" />
        <Show when={extensionProfile.plugins.length === 0}>
          <text fg={tokens.muted}>none</text>
        </Show>
        <For each={extensionProfile.plugins}>
          {(plugin) => (
            <>
              <text fg={plugin.active ? tokens.add : tokens.warn} wrapMode="word">
                {`${plugin.active ? tone("ok").glyph : tone("warn").glyph} ${pluginId(plugin.ref)}${plugin.error ? ` ${glyph("separator")} ${plugin.error}` : ""}`}
              </text>
              <For each={plugin.agents}>
                {(agent) => <text fg={tokens.muted}>{`  agent ${agent}`}</text>}
              </For>
              <For each={plugin.skills}>
                {(skill) => <text fg={tokens.muted}>{`  skill /${skill}`}</text>}
              </For>
              <For each={plugin.mcp_servers}>
                {(server) => <text fg={tokens.muted}>{`  MCP ${server}`}</text>}
              </For>
              <For each={plugin.capability_executables}>
                {(name) => <text fg={tokens.warn}>{`  service ${name}`}</text>}
              </For>
              <Show when={plugin.hooks.total > 0}>
                <text fg={tokens.muted}>{`  hooks ${plugin.hooks.total} declared`}</text>
              </Show>
            </>
          )}
        </For>
        <SectionHeader label="Standalone skills" />
        <Show when={extensionProfile.standalone_skills.length === 0}>
          <text fg={tokens.muted}>none</text>
        </Show>
        <For each={extensionProfile.standalone_skills}>
          {(skill) => (
            <text fg={skill.active ? tokens.add : tokens.warn} wrapMode="word">
              {`${skill.active ? tone("ok").glyph : tone("warn").glyph} ${skill.ref.scope}/${skill.ref.source}/${skill.ref.name}${skill.error ? ` ${glyph("separator")} ${skill.error}` : ""}`}
            </text>
          )}
        </For>
        <Show when={extensionProfile.issues.length > 0}>
          <SectionHeader label="Issues" />
          <For each={extensionProfile.issues}>
            {(issue) => (
              <text fg={tokens.del} wrapMode="word">{`${issue.code}: ${issue.message}`}</text>
            )}
          </For>
        </Show>
        <SectionHeader label="Snapshot identity" />
        <text
          fg={tokens.muted}
          wrapMode="word"
        >{`fingerprint ${extensionProfile.fingerprint}`}</text>
      </box>
    );
  }

  function deltaGroup(label: string, values: readonly string[], fg = tokens.fg): JSX.Element {
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

  function exactDelta(action: PendingPreview): JSX.Element {
    const preview = action.preview;
    const enteringHooks = preview.delta.hooks_entering.map(
      (hook) => `${pluginId(hook.plugin)} ${hook.total} hooks`,
    );
    const leavingHooks = preview.delta.hooks_leaving.map(
      (hook) => `${pluginId(hook.plugin)} ${hook.total} hooks`,
    );
    return (
      <box flexDirection="column">
        <text fg={tokens.accent} wrapMode="word">
          <b>{`${preview.current.id} ${glyph("arrowRight")} ${preview.target.id}`}</b>
        </text>
        <text fg={preview.target.status === "ready" ? tokens.add : tokens.warn}>
          {`Target status: ${preview.target.status}`}
        </text>
        {deltaGroup("Plugins entering", preview.delta.plugins_entering.map(pluginId), tokens.add)}
        {deltaGroup("Plugins leaving", preview.delta.plugins_leaving.map(pluginId), tokens.del)}
        {deltaGroup("Skills entering", preview.delta.skills_entering, tokens.add)}
        {deltaGroup("Skills leaving", preview.delta.skills_leaving, tokens.del)}
        {deltaGroup("MCP servers entering", preview.delta.mcp_servers_entering, tokens.add)}
        {deltaGroup("MCP servers leaving", preview.delta.mcp_servers_leaving, tokens.del)}
        {deltaGroup("Hooks entering", enteringHooks, tokens.warn)}
        {deltaGroup("Hooks leaving", leavingHooks, tokens.warn)}
        <Show when={preview.target.issues.length > 0}>
          <SectionHeader label={`Issues (${preview.target.issues.length})`} />
          <For each={preview.target.issues}>
            {(issue) => (
              <text fg={tokens.del} wrapMode="word">{`${issue.code}: ${issue.message}`}</text>
            )}
          </For>
        </Show>
        <Show when={preview.requires_workspace_trust}>
          <SectionHeader label="Workspace trust" />
          <text fg={tokens.warn} wrapMode="word">
            Continuing approves repository-owned plugins at this exact workspace executable
            fingerprint. Global installed plugins need no additional approval.
          </text>
        </Show>
      </box>
    );
  }

  function normalBody(): JSX.Element {
    return (
      <Show
        when={detailOpen()}
        fallback={
          <Show when={dimensions().width >= 100} fallback={list()}>
            <box flexDirection="row" flexGrow={1} minHeight={0}>
              <box width="43%" minWidth={30} paddingRight={1}>
                {list()}
              </box>
              <box flexGrow={1} minWidth={0} border={["left"]} borderColor={tokens.muted}>
                {compactPreview()}
              </box>
            </box>
          </Show>
        }
      >
        <scrollbox
          ref={(element: ScrollBoxRenderable) => (detailScroll = element)}
          flexGrow={1}
          minHeight={0}
          verticalScrollbarOptions={scrollbarOptions()}
        >
          {fullDetail()}
        </scrollbox>
      </Show>
    );
  }

  return (
    <ViewFrame
      host={host}
      title="Extension Profile"
      unscoped
      purpose="Select an exact extension snapshot for future runs"
      mutationContract="Every change previews the complete delta before reconnect"
      footerStatus={footerStatus}
    >
      <Show when={current()}>
        {(value: () => ResolvedExtensionProfile) => (
          <text fg={tokens.muted} flexShrink={0} wrapMode="none" truncate>
            <span style={{ fg: value().status === "ready" ? tokens.add : tokens.warn }}>
              {`${tone(value().status === "ready" ? "ok" : "warn").glyph} ${value().id}`}
            </span>
            {`  ${extensionProfileSummary(value(), inventory())} ${glyph("separator")} ${value().status}`}
          </text>
        )}
      </Show>
      <Show when={loadError()}>
        {(message: () => string) => (
          <box flexDirection="column" flexShrink={0}>
            <text fg={tokens.del} wrapMode="none" truncate>
              {`${tone("error").glyph} Extension Profile catalog unavailable`}
            </text>
            <text
              fg={tokens.muted}
              wrapMode="none"
              truncate
            >{`r retries ${glyph("separator")} ${message()}`}</text>
          </box>
        )}
      </Show>
      <Show
        when={pending()}
        fallback={
          <>
            <text
              fg={term() === "" ? tokens.muted : tokens.accent2}
              flexShrink={0}
              wrapMode="none"
              truncate
            >
              {term() === "" ? "/ Search by name or selected extension" : `/ ${term()}`}
            </text>
            <Show when={!detailOpen() && selected()}>
              <text fg={tokens.accent2} flexShrink={0} wrapMode="none" truncate>
                {`Enter ${glyph("arrowRight")} details   w ${glyph("arrowRight")} workspace preview   g ${glyph("arrowRight")} global preview`}
              </text>
            </Show>
            {normalBody()}
          </>
        }
      >
        {(action: () => PendingPreview) => (
          <>
            <text fg={tokens.warn} flexShrink={0} wrapMode="word">
              {pendingMessage(action())}
            </text>
            <text fg={tokens.accent2} flexShrink={0}>
              y applies and reconnects; n or Esc keeps the current Extension Profile.
            </text>
            <scrollbox
              ref={(element: ScrollBoxRenderable) => (previewScroll = element)}
              flexGrow={1}
              minHeight={0}
              verticalScrollbarOptions={scrollbarOptions()}
            >
              {exactDelta(action())}
            </scrollbox>
          </>
        )}
      </Show>
      <Show when={deps.runActive()}>
        <text fg={tokens.warn} flexShrink={0}>
          Finish the active run before changing Extension Profile.
        </text>
      </Show>
      <Show when={current()?.selection_origin === "cli"}>
        <text fg={tokens.warn} flexShrink={0} wrapMode="word">
          The active --extension-profile override is process-local; restart without it to change
          persisted selection.
        </text>
      </Show>
      <Show when={editor.editing()}>{editor.EditInput()}</Show>
      {editor.PickerInput()}
    </ViewFrame>
  );
}
