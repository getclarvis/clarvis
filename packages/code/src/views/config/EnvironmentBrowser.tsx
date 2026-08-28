import type {
  EnvironmentDefinitionView,
  EnvironmentPreview,
  EnvironmentRef,
  EnvironmentService,
  PluginRef,
  ResolvedEnvironment,
} from "@clarvis/protocol";
import { createEffect, createSignal, onMount, Show, type JSX } from "solid-js";
import { detachObserved } from "../../core/tasks.ts";
import type { ViewHost } from "../../keys/commands.ts";
import { tokens } from "../../theme/tokens.ts";
import { tone } from "../../theme/tone.ts";
import { clampListIndex } from "../../ui/patterns/list-navigation.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import {
  bindLevelKeys,
  createFieldEditor,
  DetailLines,
  SelectableList,
  SelectableRow,
  ViewFrame,
  type DetailRow,
} from "./view-host.tsx";

/** Host actions used by the Environment control plane. */
export interface EnvironmentBrowserDeps {
  environments: EnvironmentService;
  reconnect: () => Promise<{ ok: boolean; message: string }>;
  runActive: () => boolean;
  notify: (message: string, tone?: "success" | "warn" | "error") => void;
}

function id(ref: EnvironmentRef): string {
  return `${ref.scope}:${ref.name}`;
}

function authoredRef(raw: string): { scope: "global" | "workspace"; name: string } | undefined {
  const match = /^(global|workspace):([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(raw.trim());
  if (match === null) return undefined;
  return { scope: match[1] as "global" | "workspace", name: match[2]! };
}

function deltaLines(preview: EnvironmentPreview): string[] {
  const { delta } = preview;
  const refs = (values: readonly PluginRef[]): string =>
    values.length === 0
      ? "none"
      : values.map((ref) => `${ref.scope}/${ref.source}/${ref.name}`).join(", ");
  return [
    `status: ${preview.target.status}`,
    `plugins entering: ${refs(delta.plugins_entering)}`,
    `plugins leaving: ${refs(delta.plugins_leaving)}`,
    `skills entering: ${delta.skills_entering.join(", ") || "none"}`,
    `skills leaving: ${delta.skills_leaving.join(", ") || "none"}`,
    `MCP servers entering: ${delta.mcp_servers_entering.join(", ") || "none"}`,
    `MCP servers leaving: ${delta.mcp_servers_leaving.join(", ") || "none"}`,
    `hooks entering: ${delta.hooks_entering.reduce((sum, entry) => sum + entry.total, 0)}`,
    `hooks leaving: ${delta.hooks_leaving.reduce((sum, entry) => sum + entry.total, 0)}`,
    ...preview.target.issues.map((issue) => `${issue.code}: ${issue.message}`),
    ...(preview.requires_workspace_trust
      ? ["the workspace executable fingerprint will be approved if you continue"]
      : []),
  ];
}

function rowsFor(environment: ResolvedEnvironment | undefined): DetailRow[] {
  if (environment === undefined) return [];
  const status = tone(
    environment.status === "ready" ? "ok" : environment.status === "degraded" ? "warn" : "error",
  );
  const counts = environment.counts;
  return [
    { text: `${status.glyph} ${environment.status}`, fg: status.fg },
    ...(environment.description === undefined
      ? []
      : [{ text: environment.description, fg: tokens.fg }]),
    { text: `fingerprint  ${environment.fingerprint}`, fg: tokens.muted },
    { text: `selected by  ${environment.selection_origin}`, fg: tokens.muted },
    {
      text: `plugins      ${counts.plugins_active} active / ${counts.plugins_installed} installed`,
      fg: tokens.fg,
    },
    {
      text: `skills       ${counts.standalone_skills_active + counts.plugin_skills_active} active / ${counts.standalone_skills_discovered + counts.plugin_skills_discovered} discovered`,
      fg: tokens.fg,
    },
    { text: `MCP servers  ${counts.mcp_servers_active}`, fg: tokens.muted },
    {
      text: `hooks        ${counts.hooks_approved} approved / ${counts.hooks_declared} declared`,
      fg: tokens.muted,
    },
    ...environment.plugins.flatMap((plugin): DetailRow[] => [
      {
        text: `${plugin.active ? tone("ok").glyph : tone("warn").glyph} plugin ${plugin.ref.scope}/${plugin.ref.source}/${plugin.ref.name}${plugin.error === undefined ? "" : `: ${plugin.error}`}`,
        fg: plugin.active ? tokens.fg : tokens.warn,
      },
      ...plugin.agents.map((agent) => ({ text: `  agent ${agent}`, fg: tokens.muted })),
      ...plugin.skills.map((skill) => ({ text: `  skill ${skill}`, fg: tokens.muted })),
      ...plugin.mcp_servers.map((server) => ({ text: `  MCP ${server}`, fg: tokens.muted })),
      ...plugin.capability_executables.map((executable) => ({
        text: `  executable ${executable}`,
        fg: tokens.muted,
      })),
      ...(plugin.hooks.total === 0
        ? []
        : [
            {
              text: `  hooks ${plugin.hooks.approved} approved / ${plugin.hooks.total} declared`,
              fg: tokens.muted,
            },
          ]),
    ]),
    ...environment.standalone_skills.map((skill) => ({
      text: `${skill.active ? tone("ok").glyph : tone("warn").glyph} skill ${skill.ref.scope}/${skill.ref.source}/${skill.ref.name}${skill.error === undefined ? "" : `: ${skill.error}`}`,
      fg: skill.active ? tokens.fg : tokens.warn,
    })),
    ...environment.issues.map((issue) => ({
      text: `${tone("warn").glyph} ${issue.code}: ${issue.message}`,
      fg: environment.status === "invalid" ? tokens.del : tokens.warn,
    })),
  ];
}

/** Browse, diagnose, clone, create, preview and select extension Environments. */
export function EnvironmentBrowser(host: ViewHost, deps: EnvironmentBrowserDeps): JSX.Element {
  const editor = createFieldEditor(host.interaction, host.active);
  const [definitions, setDefinitions] = createSignal<EnvironmentDefinitionView[]>([]);
  const [current, setCurrent] = createSignal<ResolvedEnvironment>();
  const [detail, setDetail] = createSignal<ResolvedEnvironment>();
  const [sel, setSel] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  let detailEpoch = 0;

  const selected = (): EnvironmentDefinitionView | undefined =>
    definitions()[clampListIndex(sel(), definitions().length)];
  const selectionMutable = (): boolean => current()?.selection_origin !== "cli";

  const report = (error: unknown): void =>
    deps.notify(error instanceof Error ? error.message : String(error), "warn");

  const reload = async (): Promise<void> => {
    const [nextDefinitions, nextCurrent] = await Promise.all([
      deps.environments.list(),
      deps.environments.current(),
    ]);
    setDefinitions(nextDefinitions);
    setCurrent(nextCurrent);
    setSel((index) => clampListIndex(index, nextDefinitions.length));
  };

  const act = (name: string, task: () => Promise<void>): void => {
    if (busy()) return;
    setBusy(true);
    detachObserved(
      name,
      async () => {
        try {
          await task();
        } finally {
          setBusy(false);
        }
      },
      report,
    );
  };

  const apply = (selectionScope: "global" | "workspace"): void => {
    const target = selected();
    if (target === undefined || deps.runActive() || !selectionMutable()) return;
    act("environment_select", async () => {
      const preview = await deps.environments.preview(target.ref, {
        selection_scope: selectionScope,
      });
      const approved = await host.confirm({
        message: `Use ${id(target.ref)} ${selectionScope === "workspace" ? "in this workspace" : "as the global default"}?`,
        detail: deltaLines(preview),
        danger:
          preview.delta.plugins_entering.length > 0 || preview.delta.hooks_entering.length > 0,
        confirmLabel: "apply and reconnect",
        cancelLabel: "keep current",
      });
      if (!approved) return;
      await deps.environments.select(target.ref, {
        selection_scope: selectionScope,
        preview_token: preview.token,
        ...(preview.requires_workspace_trust ? { approve_workspace: true } : {}),
      });
      const reconnected = await deps.reconnect();
      await reload();
      deps.notify(
        reconnected.ok
          ? `${id(target.ref)} is active for new runs`
          : `${id(target.ref)} was selected; reconnect with /reconnect (${reconnected.message})`,
        reconnected.ok ? "success" : "warn",
      );
    });
  };

  const clearPersistedSelection = (scope: "global" | "workspace"): void => {
    if (deps.runActive() || !selectionMutable()) return;
    act(`environment_clear_${scope}`, async () => {
      const preview = await deps.environments.previewClear(scope);
      const label = scope === "workspace" ? "this workspace's selection" : "the global default";
      const approved = await host.confirm({
        message: `Clear ${label} and fall back to ${preview.target.id}?`,
        detail: deltaLines(preview),
        danger:
          preview.delta.plugins_entering.length > 0 || preview.delta.hooks_entering.length > 0,
        confirmLabel: "clear and reconnect",
        cancelLabel: "keep current",
      });
      if (!approved) return;
      await deps.environments.clearSelection(scope, { preview_token: preview.token });
      const reconnected = await deps.reconnect();
      await reload();
      deps.notify(
        reconnected.ok
          ? `${scope === "workspace" ? "workspace selection" : "global default"} cleared`
          : `${label} was cleared; reconnect with /reconnect (${reconnected.message})`,
        reconnected.ok ? "success" : "warn",
      );
    });
  };

  createEffect(() => {
    const ref = selected()?.ref;
    if (ref === undefined) {
      setDetail(undefined);
      return;
    }
    const epoch = ++detailEpoch;
    detachObserved(
      "environment_detail",
      async () => {
        const resolved = await deps.environments.get(ref);
        if (epoch === detailEpoch) setDetail(resolved);
      },
      report,
    );
  });
  onMount(() => act("environments_reload", reload));

  const spec = (): LevelSpec => ({
    nav: { count: () => definitions().length, index: sel, setIndex: setSel },
    verbs: [
      { key: "r", label: "refresh", run: () => act("environments_reload", reload) },
      {
        key: "w",
        label: "use in workspace",
        when: () => selected() !== undefined && !deps.runActive() && !busy() && selectionMutable(),
        run: () => apply("workspace"),
      },
      {
        key: "g",
        label: "set global default",
        when: () =>
          selected()?.ref.scope !== "workspace" &&
          !deps.runActive() &&
          !busy() &&
          selectionMutable(),
        run: () => apply("global"),
      },
      {
        key: "n",
        label: "new empty",
        when: () => !busy(),
        run: () =>
          editor.start("new Environment (global:name or workspace:name)", "", (raw) => {
            const ref = authoredRef(raw);
            if (ref === undefined) {
              deps.notify("use global:name or workspace:name", "warn");
              return;
            }
            act("environment_create", async () => {
              await deps.environments.create({
                ref,
                definition: { schema_version: 1, plugins: [], skills: [] },
              });
              await reload();
              deps.notify(`created ${id(ref)}`, "success");
            });
          }),
      },
      {
        key: "c",
        label: "clone",
        when: () => selected() !== undefined && !busy(),
        run: () =>
          editor.start("clone to (global:name or workspace:name)", "", (raw) => {
            const source = selected()?.ref;
            const target = authoredRef(raw);
            if (source === undefined || target === undefined) {
              deps.notify("use global:name or workspace:name", "warn");
              return;
            }
            act("environment_clone", async () => {
              await deps.environments.clone(source, target);
              await reload();
              deps.notify(`cloned ${id(source)} to ${id(target)}`, "success");
            });
          }),
      },
      {
        key: "x",
        label: "clear local selection",
        when: () => !deps.runActive() && !busy() && selectionMutable(),
        run: () => clearPersistedSelection("workspace"),
      },
      {
        key: "d",
        label: "clear global default",
        when: () => !deps.runActive() && !busy() && selectionMutable(),
        run: () => clearPersistedSelection("global"),
      },
    ],
  });

  bindLevelKeys({
    host,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
    editor,
  });

  return (
    <ViewFrame host={host} title="Environment" unscoped>
      <Show when={current()}>
        {(value: () => ResolvedEnvironment) => (
          <text fg={tokens.muted} flexShrink={0}>
            {`Active: ${value().id}  ${value().counts.plugins_active}/${value().counts.plugins_installed} plugins  ${value().counts.standalone_skills_active + value().counts.plugin_skills_active}/${value().counts.standalone_skills_discovered + value().counts.plugin_skills_discovered} skills  ${value().status}`}
          </text>
        )}
      </Show>
      <SelectableList<EnvironmentDefinitionView>
        each={definitions}
        sel={sel}
        idPrefix="environment-"
        empty={() => ({ text: busy() ? "loading Environments" : "no Environments found" })}
        row={(environment, index) => {
          const active = current()?.id === id(environment.ref);
          return (
            <SelectableRow selected={sel() === index()}>
              <span style={{ fg: active ? tone("ok").fg : tokens.muted }}>
                {active ? tone("ok").glyph : " "}{" "}
              </span>
              <span style={{ fg: tokens.fg }}>{id(environment.ref)}</span>
              <span style={{ fg: tokens.muted }}>
                {environment.immutable ? "  builtin" : ""}
                {environment.error === undefined ? "" : "  invalid"}
              </span>
            </SelectableRow>
          );
        }}
        trailing={
          <Show when={detail()}>
            {(value: () => ResolvedEnvironment) => (
              <box flexDirection="column" flexShrink={0} paddingTop={1}>
                <DetailLines rows={rowsFor(value())} />
              </box>
            )}
          </Show>
        }
      />
      <Show when={deps.runActive()}>
        <text fg={tokens.warn} flexShrink={0}>
          Finish the active run before changing Environment.
        </text>
      </Show>
      <Show when={current()?.selection_origin === "cli"}>
        <text fg={tokens.warn} flexShrink={0}>
          The active --env override is process-local; restart without it to change persisted
          selection.
        </text>
      </Show>
      <Show when={editor.editing()}>{editor.EditInput()}</Show>
      {editor.PickerInput()}
    </ViewFrame>
  );
}
