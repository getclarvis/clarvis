import type { Accessor, JSX } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import type { TaskProviderStatusDto } from "@clarvis/protocol";
import { detachObserved } from "../../core/tasks.ts";
import { glyph } from "../../theme/glyphs.ts";
import { tokens } from "../../theme/tokens.ts";
import type { ViewHost } from "../../keys/commands.ts";
import {
  defaultPlansSettings,
  type PlansSettingsBlock,
  type SettingsAdapter,
  type SettingsFile,
} from "../../adapters/settings.ts";
import type { PluginView } from "../../adapters/plugins.ts";
import {
  effectiveMemoryProvider,
  effectivePlanProvider,
  memoryProviderLabel,
  planProviderLabel,
  providerPluginOptions,
  validateMemoryProviderDraft,
  validatePlanProviderDraft,
  type MemoryProviderConfig,
  type MemorySettingsBlock,
  type PlanProviderConfig,
  type ProviderCapability,
} from "../../adapters/capability-providers.ts";
import { errorText } from "../../adapters/errors.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import {
  bindLevelKeys,
  createFieldEditor,
  DetailLines,
  FieldRow,
  LevelHost,
  SectionHeader,
  StatusRow,
} from "./view-host.tsx";

type Panel = "plans" | "memory" | "tasks";
type TasksSettingsBlock = NonNullable<SettingsFile["tasks"]>;

export interface CapabilityProvidersDeps {
  settings: SettingsAdapter;
  plugins: Accessor<PluginView[]>;
  notify: (message: string) => void;
  openPlugins: () => void;
  tasks: {
    status(): Promise<TaskProviderStatusDto>;
    capabilities(): Promise<unknown>;
  };
}

const PLAN_KINDS = [
  { value: "markdown", label: "Markdown", detail: "built-in plan store" },
  { value: "executable", label: "executable", detail: "persistent JSON-RPC service" },
  { value: "plugin", label: "plugin", detail: "installed capability executable" },
];

const MEMORY_KINDS = [
  { value: "wiki", label: "wiki", detail: "built-in navigable Markdown memory" },
  { value: "file", label: "file", detail: "read-only workspace files" },
  { value: "executable", label: "executable", detail: "persistent JSON-RPC service" },
  { value: "mcp", label: "MCP", detail: "maps Clarvis operations to server tools" },
  { value: "plugin", label: "plugin", detail: "installed capability executable" },
];

const MCP_READ_DEFAULTS = {
  list_memories: "list_memories",
  read_memory: "read_memory",
  grep_memories: "grep_memories",
  query_memories: "query_memories",
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Per-scope provider selection for the fixed Memory and Plans capabilities.
 * Everything shown here is derived from settings and plugin manifests/trust;
 * opening or navigating the panel never locates, preflights, or imports code.
 */
export function CapabilityProvidersPanel(
  host: ViewHost,
  deps: CapabilityProvidersDeps,
): JSX.Element {
  const fe = createFieldEditor(host.interaction, host.active);
  const [panel, setPanel] = createSignal<Panel>("plans");
  const [rootSel, setRootSel] = createSignal(0);
  const [planSel, setPlanSel] = createSignal(0);
  const [memorySel, setMemorySel] = createSignal(0);
  const [taskSel, setTaskSel] = createSignal(0);
  const [planDraft, setPlanDraft] = createSignal<PlansSettingsBlock>();
  const [memoryDraft, setMemoryDraft] = createSignal<MemorySettingsBlock>();
  const [taskDraft, setTaskDraft] = createSignal<TasksSettingsBlock>();
  const [taskTest, setTaskTest] = createSignal("not tested");
  let planChanged = false;
  let memoryChanged = false;
  let taskChanged = false;

  const scopedPlanBlock = (): PlansSettingsBlock | undefined =>
    deps.settings.read(host.scope())?.plans;
  const scopedMemoryBlock = (): MemorySettingsBlock | undefined =>
    deps.settings.read(host.scope())?.memory;
  const scopedTaskBlock = (): TasksSettingsBlock | undefined =>
    deps.settings.read(host.scope())?.tasks;
  const effectivePlanBlock = (): PlansSettingsBlock | undefined =>
    host.scope() === "workspace"
      ? (deps.settings.read("workspace")?.plans ?? deps.settings.read("global")?.plans)
      : deps.settings.read("global")?.plans;
  const effectiveMemoryBlock = (): MemorySettingsBlock | undefined =>
    host.scope() === "workspace"
      ? (deps.settings.read("workspace")?.memory ?? deps.settings.read("global")?.memory)
      : deps.settings.read("global")?.memory;
  const effectiveTaskBlock = (): TasksSettingsBlock | undefined =>
    host.scope() === "workspace"
      ? (deps.settings.read("workspace")?.tasks ?? deps.settings.read("global")?.tasks)
      : deps.settings.read("global")?.tasks;

  function load(): void {
    setPlanDraft(scopedPlanBlock() ? clone(scopedPlanBlock()!) : undefined);
    setMemoryDraft(scopedMemoryBlock() ? clone(scopedMemoryBlock()!) : undefined);
    setTaskDraft(scopedTaskBlock() ? clone(scopedTaskBlock()!) : undefined);
    planChanged = false;
    memoryChanged = false;
    taskChanged = false;
    setPlanSel(0);
    setMemorySel(0);
    setTaskSel(0);
    setTaskTest("checking…");
    host.markDirty(false);
    refreshTaskStatus();
  }
  host.bindScope({ mode: "reload", load });
  load();

  function markChanged(which: Panel): void {
    if (which === "plans") planChanged = true;
    else if (which === "memory") memoryChanged = true;
    else taskChanged = true;
    host.markDirty(true);
  }

  function basePlanOverride(): PlansSettingsBlock {
    return clone(planDraft() ?? effectivePlanBlock() ?? defaultPlansSettings());
  }

  function baseMemoryOverride(): MemorySettingsBlock {
    return clone(memoryDraft() ?? effectiveMemoryBlock() ?? { enabled: true });
  }

  function baseTaskOverride(): TasksSettingsBlock {
    return clone(
      taskDraft() ??
        effectiveTaskBlock() ?? {
          provider: {
            kind: "mcp",
            server: deps.settings.declaredMcpServers()[0]?.name ?? "",
            protocol: "clarvis.tasks.v2",
          },
          writes: "disabled",
        },
    );
  }

  function setPlanProvider(provider: PlanProviderConfig): void {
    setPlanDraft({ ...basePlanOverride(), provider });
    markChanged("plans");
  }

  function setMemoryProvider(provider: MemoryProviderConfig): void {
    setMemoryDraft({ ...baseMemoryOverride(), provider });
    markChanged("memory");
  }

  function setTaskBlock(next: TasksSettingsBlock): void {
    setTaskDraft(next);
    markChanged("tasks");
    setTaskTest("changed · test after save");
  }

  const shownPlanProvider = (): PlanProviderConfig =>
    effectivePlanProvider(planDraft() ?? effectivePlanBlock());
  const shownMemoryProvider = (): MemoryProviderConfig =>
    effectiveMemoryProvider(memoryDraft() ?? effectiveMemoryBlock());

  function origin(which: Panel): string {
    const local =
      which === "plans"
        ? scopedPlanBlock()
        : which === "memory"
          ? scopedMemoryBlock()
          : scopedTaskBlock();
    if (local) return host.scope();
    if (host.scope() === "workspace") {
      const global =
        which === "plans"
          ? deps.settings.read("global")?.plans
          : which === "memory"
            ? deps.settings.read("global")?.memory
            : deps.settings.read("global")?.tasks;
      if (global) return "global (inherited)";
    }
    return which === "tasks" ? "not configured" : "built-in default";
  }

  function selectPlanKind(kind: string): void {
    const current = shownPlanProvider();
    if (kind === "markdown") setPlanProvider({ kind: "markdown" });
    else if (kind === "executable") {
      setPlanProvider({
        kind: "executable",
        command: current.kind === "executable" ? current.command : "",
        args: current.kind === "executable" ? current.args : [],
        env: current.kind === "executable" ? current.env : {},
        timeout_ms: current.kind === "executable" ? current.timeout_ms : 30_000,
        ...(current.kind === "executable" && current.platforms !== undefined
          ? { platforms: current.platforms }
          : {}),
      });
    } else {
      const first = providerPluginOptions(
        deps.plugins(),
        "plans",
        current.kind === "plugin" ? current.plugin : undefined,
      )[0];
      setPlanProvider({
        kind: "plugin",
        plugin: current.kind === "plugin" ? current.plugin : (first?.name ?? ""),
      });
    }
  }

  function selectMemoryKind(kind: string): void {
    const current = shownMemoryProvider();
    switch (kind) {
      case "wiki":
        setMemoryProvider({ kind: "wiki" });
        break;
      case "file":
        setMemoryProvider({ kind: "file", paths: current.kind === "file" ? current.paths : [] });
        break;
      case "executable":
        setMemoryProvider({
          kind: "executable",
          command: current.kind === "executable" ? current.command : "",
          args: current.kind === "executable" ? current.args : [],
          env: current.kind === "executable" ? current.env : {},
          timeout_ms: current.kind === "executable" ? current.timeout_ms : 30_000,
          ...(current.kind === "executable" && current.platforms !== undefined
            ? { platforms: current.platforms }
            : {}),
        });
        break;
      case "mcp":
        setMemoryProvider({
          kind: "mcp",
          server: current.kind === "mcp" ? current.server : "",
          tools: current.kind === "mcp" ? clone(current.tools) : { ...MCP_READ_DEFAULTS },
          ...(current.kind === "mcp" && current.seed_tool ? { seed_tool: current.seed_tool } : {}),
        });
        break;
      case "plugin": {
        const first = providerPluginOptions(
          deps.plugins(),
          "memory",
          current.kind === "plugin" ? current.plugin : undefined,
        )[0];
        setMemoryProvider({
          kind: "plugin",
          plugin: current.kind === "plugin" ? current.plugin : (first?.name ?? ""),
        });
        break;
      }
    }
  }

  function pluginPicker(
    capability: ProviderCapability,
    selected: string,
    commit: (name: string) => void,
  ): void {
    const options = providerPluginOptions(deps.plugins(), capability, selected);
    if (options.length === 0) {
      deps.notify(
        `no installed plugin offers ${capability} ${glyph("emDash")} open Plugins to install, enable and approve one`,
      );
      return;
    }
    fe.startEnum(
      `${capability} plugin`,
      options.map((option) => ({ label: option.name, value: option.name, detail: option.detail })),
      selected,
      commit,
    );
  }

  function patchMcpTool(
    field: keyof Extract<MemoryProviderConfig, { kind: "mcp" }>["tools"],
    value: string,
  ): void {
    const current = shownMemoryProvider();
    if (current.kind !== "mcp") return;
    const optional =
      field === "write_memory" || field === "edit_memory" || field === "delete_memory";
    const tools = {
      ...current.tools,
      [field]: optional && value.trim() === "" ? undefined : value.trim(),
    };
    setMemoryProvider({ ...current, tools });
  }

  function editPlan(): void {
    const provider = shownPlanProvider();
    if (planSel() === 0) {
      fe.startEnum("plans provider", PLAN_KINDS, provider.kind, selectPlanKind);
    } else if (provider.kind === "executable") {
      if (planSel() === 1) {
        fe.start("command", provider.command, (command) =>
          setPlanProvider({ ...provider, command: command.trim() }),
        );
      } else if (planSel() === 2) {
        fe.startMultiline("args (one per line)", (provider.args ?? []).join("\n"), (raw) =>
          setPlanProvider({ ...provider, args: raw.split("\n").filter((arg) => arg.length > 0) }),
        );
      } else {
        fe.startNumber("timeout_ms", provider.timeout_ms, {
          min: 1,
          max: 600_000,
          commit: (timeout_ms) =>
            setPlanProvider({ ...provider, timeout_ms: timeout_ms ?? 30_000 }),
          notify: deps.notify,
        });
      }
    } else if (provider.kind === "plugin") {
      pluginPicker("plans", provider.plugin, (plugin) =>
        setPlanProvider({ kind: "plugin", plugin }),
      );
    }
  }

  function editMemory(): void {
    const provider = shownMemoryProvider();
    const row = memorySel();
    if (row === 0) {
      fe.startEnum("memory provider", MEMORY_KINDS, provider.kind, selectMemoryKind);
      return;
    }
    if (provider.kind === "file") {
      fe.startMultiline("paths (one per line)", provider.paths.join("\n"), (raw) =>
        setMemoryProvider({
          kind: "file",
          paths: raw
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean),
        }),
      );
    } else if (provider.kind === "executable") {
      if (row === 1)
        fe.start("command", provider.command, (command) =>
          setMemoryProvider({ ...provider, command: command.trim() }),
        );
      else if (row === 2)
        fe.startMultiline("args (one per line)", (provider.args ?? []).join("\n"), (raw) =>
          setMemoryProvider({ ...provider, args: raw.split("\n").filter((arg) => arg.length > 0) }),
        );
      else
        fe.startNumber("timeout_ms", provider.timeout_ms, {
          min: 1,
          max: 600_000,
          commit: (timeout_ms) => {
            setMemoryProvider({ ...provider, timeout_ms: timeout_ms ?? 30_000 });
          },
          notify: deps.notify,
        });
    } else if (provider.kind === "mcp") {
      if (row === 1)
        fe.start("server", provider.server, (server) =>
          setMemoryProvider({ ...provider, server: server.trim() }),
        );
      else if (row === 2)
        fe.start("seed_tool (optional)", provider.seed_tool ?? "", (seed_tool) =>
          setMemoryProvider({ ...provider, seed_tool: seed_tool.trim() || undefined }),
        );
      else {
        const fields = [
          "list_memories",
          "read_memory",
          "grep_memories",
          "query_memories",
          "write_memory",
          "edit_memory",
          "delete_memory",
        ] as const;
        const field = fields[row - 3];
        if (field)
          fe.start(field, provider.tools[field] ?? "", (value) => patchMcpTool(field, value));
      }
    } else if (provider.kind === "plugin") {
      pluginPicker("memory", provider.plugin, (plugin) =>
        setMemoryProvider({ kind: "plugin", plugin }),
      );
    }
  }

  function editTasks(): void {
    const block = baseTaskOverride();
    switch (taskSel()) {
      case 0: {
        const servers = deps.settings.declaredMcpServers();
        if (servers.length === 0) {
          deps.notify(
            `no effective MCP server is available ${glyph("emDash")} declare one or enable a plugin first`,
          );
          return;
        }
        fe.startEnum(
          "Tasks MCP server",
          servers.map((server) => ({
            label: server.name,
            value: server.name,
            detail: server.type,
          })),
          block.provider.server,
          (server) =>
            setTaskBlock({
              ...block,
              provider: { kind: "mcp", server, protocol: "clarvis.tasks.v2" },
            }),
        );
        break;
      }
      case 1:
        fe.start(
          "default container (optional)",
          block.default_container ?? "",
          (default_container) =>
            setTaskBlock({
              ...block,
              ...(default_container.trim()
                ? { default_container: default_container.trim() }
                : { default_container: undefined }),
            }),
          { alwaysCommit: true },
        );
        break;
      case 2:
        fe.startEnum(
          "remote writes",
          [
            { value: "disabled", label: "disabled", detail: "read and inspect only" },
            { value: "enabled", label: "enabled", detail: "grants still gate agent writes" },
          ],
          block.writes ?? "disabled",
          (writes) => setTaskBlock({ ...block, writes: writes as "disabled" | "enabled" }),
        );
        break;
    }
  }

  function testTasks(): void {
    if (taskChanged) {
      deps.notify("save the Tasks provider selection before testing it");
      return;
    }
    setTaskTest("testing…");
    detachObserved("tasks_provider_test", () =>
      deps.tasks.capabilities().then(
        () => {
          setTaskTest("ready · clarvis.tasks.v2");
          deps.notify("Tasks provider is compatible");
        },
        (error) => {
          const text = errorText(error);
          setTaskTest(`unavailable · ${text}`);
          deps.notify(text);
        },
      ),
    );
  }

  function refreshTaskStatus(): void {
    detachObserved(
      "tasks_provider_status",
      () =>
        deps.tasks.status().then((status) => {
          setTaskTest(status.reason ? `${status.state} · ${status.reason}` : status.state);
        }),
      (error) => setTaskTest(`unavailable · ${errorText(error)}`),
    );
  }

  function otherFields(which: Panel): string[] {
    const block =
      which === "plans" ? planDraft() : which === "memory" ? memoryDraft() : taskDraft();
    if (!block) return [];
    return Object.keys(block).filter((key) => key !== "provider");
  }

  function inherit(which: Panel): void {
    const block =
      which === "plans" ? planDraft() : which === "memory" ? memoryDraft() : taskDraft();
    if (!block) {
      deps.notify(`${which} already inherits at ${host.scope()} scope`);
      return;
    }
    const apply = (): void => {
      if (which === "plans") {
        setPlanDraft(undefined);
        planChanged = true;
      } else if (which === "memory") {
        setMemoryDraft(undefined);
        memoryChanged = true;
      } else {
        setTaskDraft(undefined);
        taskChanged = true;
        setTaskTest("not configured at this scope");
      }
      host.markDirty(true);
      deps.notify(
        `${which} block removed from the ${host.scope()} draft ${glyph("emDash")} save to apply`,
      );
    };
    const siblings = otherFields(which);
    if (siblings.length === 0) {
      apply();
      return;
    }
    detachObserved("capability_provider_inherit", () =>
      host
        .confirm({
          message: `Inherit ${which} from the parent scope?`,
          detail: [`also removes: ${siblings.join(", ")}`],
          confirmLabel: "inherit",
          cancelLabel: "keep override",
        })
        .then((ok) => {
          if (ok) apply();
        }),
    );
  }

  async function save(): Promise<void> {
    if (planChanged && planDraft()) {
      const issue = validatePlanProviderDraft(planDraft()!);
      if (issue) {
        deps.notify(`cannot save plans ${glyph("emDash")} ${issue.message}`);
        setPanel("plans");
        if (host.level.depth() === 0) host.level.push("Plans");
        return;
      }
    }
    if (memoryChanged && memoryDraft()) {
      const issue = validateMemoryProviderDraft(memoryDraft()!);
      if (issue) {
        deps.notify(`cannot save memory ${glyph("emDash")} ${issue.message}`);
        setPanel("memory");
        if (host.level.depth() === 0) host.level.push("Memory");
        return;
      }
    }
    if (taskChanged && taskDraft() && taskDraft()!.provider.server.trim().length === 0) {
      deps.notify(`cannot save Tasks ${glyph("emDash")} select an MCP server`);
      setPanel("tasks");
      if (host.level.depth() === 0) host.level.push("Tasks");
      return;
    }
    const patch: {
      plans?: PlansSettingsBlock;
      memory?: MemorySettingsBlock;
      tasks?: TasksSettingsBlock;
    } = {};
    if (planChanged) patch.plans = planDraft();
    if (memoryChanged) patch.memory = memoryDraft();
    if (taskChanged) patch.tasks = taskDraft();
    if (!planChanged && !memoryChanged && !taskChanged) return;
    try {
      await deps.settings.write(host.scope(), patch);
      planChanged = false;
      memoryChanged = false;
      taskChanged = false;
      host.markDirty(false);
      setTaskTest("checking…");
      refreshTaskStatus();
      deps.notify(`saved ${host.scope()} capability providers`);
    } catch (error) {
      deps.notify(errorText(error));
    }
  }
  host.onSave(save);

  const memoryRows = (): number => {
    switch (shownMemoryProvider().kind) {
      case "wiki":
        return 1;
      case "file":
      case "plugin":
        return 2;
      case "executable":
        return 4;
      case "mcp":
        return 10;
    }
  };

  function openPanel(next: Panel): void {
    setPanel(next);
    host.level.push(next === "plans" ? "Plans" : next === "memory" ? "Memory" : "Tasks");
  }

  const spec = (depth = host.level.depth()): LevelSpec => {
    if (depth === 0) {
      return {
        nav: {
          count: () => 3,
          index: rootSel,
          setIndex: setRootSel,
          activate: {
            label: "configure",
            run: () => openPanel(rootSel() === 0 ? "plans" : rootSel() === 1 ? "memory" : "tasks"),
          },
        },
      };
    }
    const which = panel();
    return {
      nav: {
        count: () =>
          which === "plans"
            ? shownPlanProvider().kind === "markdown"
              ? 1
              : shownPlanProvider().kind === "executable"
                ? 4
                : 2
            : which === "memory"
              ? memoryRows()
              : 3,
        index: which === "plans" ? planSel : which === "memory" ? memorySel : taskSel,
        setIndex: which === "plans" ? setPlanSel : which === "memory" ? setMemorySel : setTaskSel,
        activate: {
          label: "edit",
          run: which === "plans" ? editPlan : which === "memory" ? editMemory : editTasks,
        },
      },
      verbs: [
        { key: "i", label: "inherit", run: () => inherit(which) },
        { key: "p", label: "Plugins", when: () => !host.dirty(), run: deps.openPlugins },
        {
          key: "t",
          label: "test",
          when: () => which === "tasks" && !host.dirty(),
          run: testTasks,
        },
      ],
    };
  };

  bindLevelKeys({
    host,
    editor: fe,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  const overrideNote = (which: Panel): string =>
    (
      which === "plans"
        ? scopedPlanBlock()
        : which === "memory"
          ? scopedMemoryBlock()
          : scopedTaskBlock()
    )
      ? `override in ${host.scope()}`
      : `no ${host.scope()} override`;

  function pluginRows(capability: ProviderCapability, selected: string): JSX.Element {
    const options = () => providerPluginOptions(deps.plugins(), capability, selected);
    return (
      <DetailLines
        indent
        rows={options().map((option) => ({
          text: `${option.name} ${glyph("separator")} ${option.detail}`,
          fg:
            option.gate === "ready"
              ? tokens.add
              : option.gate === "broken"
                ? tokens.del
                : tokens.warn,
        }))}
      />
    );
  }

  function skillPolicyRows(selected: string): JSX.Element {
    const policies = () =>
      deps.plugins().find((plugin) => plugin.name === selected)?.contributions.skillPlanPolicies ??
      [];
    return (
      <DetailLines
        indent
        rows={policies().map((policy) => ({
          text: `/${policy.skill} ${glyph("arrowRight")} plans:${policy.mode}`,
          fg: policy.mode === "review" ? tokens.warn : tokens.muted,
        }))}
      />
    );
  }

  function rootBody(): JSX.Element {
    return (
      <box flexDirection="column">
        <StatusRow label="scope" text={host.scope()} fg={tokens.accent2} />
        <FieldRow
          label="Plans"
          value={planProviderLabel(effectivePlanProvider(effectivePlanBlock()))}
          selected={rootSel() === 0}
          note={`${origin("plans")} ${glyph("separator")} ${overrideNote("plans")}`}
        />
        <FieldRow
          label="Memory"
          value={memoryProviderLabel(effectiveMemoryProvider(effectiveMemoryBlock()))}
          selected={rootSel() === 1}
          note={`${origin("memory")} ${glyph("separator")} ${overrideNote("memory")}`}
        />
        <FieldRow
          label="Tasks"
          value={effectiveTaskBlock()?.provider.server ?? "not configured"}
          selected={rootSel() === 2}
          note={`${origin("tasks")} ${glyph("separator")} ${overrideNote("tasks")}`}
        />
        <DetailLines
          indent
          rows={[
            {
              text: "Selection is configuration only; opening this screen never executes provider code.",
              fg: tokens.muted,
            },
            {
              text: "Installation, enablement and provider selection authorize packaged services.",
              fg: tokens.muted,
            },
          ]}
        />
      </box>
    );
  }

  function plansBody(): JSX.Element {
    const provider = shownPlanProvider();
    return (
      <box flexDirection="column">
        <StatusRow label="effective" text={planProviderLabel(provider)} fg={tokens.accent2} />
        <StatusRow
          label="origin"
          text={`${origin("plans")} · ${overrideNote("plans")}`}
          fg={tokens.muted}
        />
        <SectionHeader label={`settings (${host.scope()})`} />
        <FieldRow
          label="provider"
          kind="enum"
          value={provider.kind}
          selected={planSel() === 0}
          note="Markdown · executable · plugin"
        />
        <Show when={provider.kind === "executable"}>
          {() => {
            const executable = provider as Extract<PlanProviderConfig, { kind: "executable" }>;
            return (
              <>
                <FieldRow
                  label="command"
                  value={executable.command || "(required)"}
                  selected={planSel() === 1}
                />
                <FieldRow
                  label="args"
                  value={(executable.args ?? []).join(" ") || "(none)"}
                  selected={planSel() === 2}
                />
                <FieldRow
                  label="timeout_ms"
                  value={String(executable.timeout_ms ?? 30_000)}
                  selected={planSel() === 3}
                />
              </>
            );
          }}
        </Show>
        <Show when={provider.kind === "plugin"}>
          {() => {
            const plugin = provider as Extract<PlanProviderConfig, { kind: "plugin" }>;
            return (
              <>
                <FieldRow
                  label="plugin"
                  kind="enum"
                  value={plugin.plugin || "(required)"}
                  selected={planSel() === 1}
                  note="starts only when selected"
                  noteFg={tokens.warn}
                />
                {pluginRows("plans", plugin.plugin)}
                {skillPolicyRows(plugin.plugin)}
              </>
            );
          }}
        </Show>
        <DetailLines
          indent
          rows={[
            {
              text: "The service is initialized lazily and speaks JSON-RPC 2.0 over JSON Lines.",
              fg: tokens.muted,
            },
          ]}
        />
      </box>
    );
  }

  function memoryBody(): JSX.Element {
    const provider = shownMemoryProvider();
    const mcp = provider.kind === "mcp" ? provider : undefined;
    return (
      <box flexDirection="column">
        <StatusRow label="effective" text={memoryProviderLabel(provider)} fg={tokens.accent2} />
        <StatusRow
          label="origin"
          text={`${origin("memory")} · ${overrideNote("memory")}`}
          fg={tokens.muted}
        />
        <SectionHeader label={`settings (${host.scope()})`} />
        <FieldRow
          label="provider"
          kind="enum"
          value={provider.kind}
          selected={memorySel() === 0}
          note="wiki · file · MCP · executable · plugin"
        />
        <Show when={provider.kind === "file"}>
          <FieldRow
            label="paths"
            value={
              (provider as Extract<MemoryProviderConfig, { kind: "file" }>).paths.join(", ") ||
              "(required)"
            }
            selected={memorySel() === 1}
            note="one workspace-relative path per line"
          />
        </Show>
        <Show when={provider.kind === "executable"}>
          {() => {
            const executable = provider as Extract<MemoryProviderConfig, { kind: "executable" }>;
            return (
              <>
                <FieldRow
                  label="command"
                  value={executable.command || "(required)"}
                  selected={memorySel() === 1}
                />
                <FieldRow
                  label="args"
                  value={(executable.args ?? []).join(" ") || "(none)"}
                  selected={memorySel() === 2}
                />
                <FieldRow
                  label="timeout_ms"
                  value={String(executable.timeout_ms ?? 30_000)}
                  selected={memorySel() === 3}
                  note="1–600000"
                />
              </>
            );
          }}
        </Show>
        <Show when={mcp}>
          <FieldRow
            label="server"
            value={mcp!.server || "(required)"}
            selected={memorySel() === 1}
          />
          <FieldRow
            label="seed_tool"
            value={mcp!.seed_tool ?? "(none)"}
            selected={memorySel() === 2}
            note="optional"
          />
          <For
            each={
              [
                "list_memories",
                "read_memory",
                "grep_memories",
                "query_memories",
                "write_memory",
                "edit_memory",
                "delete_memory",
              ] as const
            }
          >
            {(field, index) => (
              <FieldRow
                label={field}
                value={mcp!.tools[field] ?? "(none)"}
                selected={memorySel() === index() + 3}
                note={index() < 4 ? "required" : "write trio: all or none"}
              />
            )}
          </For>
        </Show>
        <Show when={provider.kind === "plugin"}>
          {() => {
            const plugin = provider as Extract<MemoryProviderConfig, { kind: "plugin" }>;
            return (
              <>
                <FieldRow
                  label="plugin"
                  kind="enum"
                  value={plugin.plugin || "(required)"}
                  selected={memorySel() === 1}
                  note="starts only when selected"
                  noteFg={tokens.warn}
                />
                {pluginRows("memory", plugin.plugin)}
              </>
            );
          }}
        </Show>
        <Show when={provider.kind === "executable" || provider.kind === "plugin"}>
          <DetailLines
            indent
            rows={[
              {
                text: "The provider is a persistent JSON-RPC service and may be written in any language.",
                fg: tokens.muted,
              },
            ]}
          />
        </Show>
      </box>
    );
  }

  function tasksBody(): JSX.Element {
    const block = taskDraft() ?? effectiveTaskBlock();
    const shown = block ?? baseTaskOverride();
    const selectedPlugin = deps
      .plugins()
      .find((plugin) => plugin.contributions.servers.includes(shown.provider.server));
    return (
      <box flexDirection="column">
        <StatusRow
          label="effective"
          text={block ? shown.provider.server : "not configured"}
          fg={block ? tokens.accent2 : tokens.warn}
        />
        <StatusRow
          label="origin"
          text={`${origin("tasks")} · ${overrideNote("tasks")}`}
          fg={tokens.muted}
        />
        <StatusRow
          label="health"
          text={taskTest()}
          fg={taskTest().startsWith("ready") ? tokens.add : tokens.muted}
        />
        <SectionHeader label={`settings (${host.scope()})`} />
        <FieldRow
          label="server"
          kind="enum"
          value={shown.provider.server || "(required)"}
          selected={taskSel() === 0}
          note="effective MCP name; plugin servers are namespaced"
        />
        <FieldRow
          label="default container"
          value={shown.default_container ?? "(none)"}
          selected={taskSel() === 1}
        />
        <FieldRow
          label="writes"
          kind="enum"
          value={shown.writes ?? "disabled"}
          selected={taskSel() === 2}
          note="operator gate; Agent Profile grants remain required"
          noteFg={shown.writes === "enabled" ? tokens.warn : tokens.muted}
        />
        <DetailLines
          indent
          rows={[
            { text: "protocol · clarvis.tasks.v2 (fixed)", fg: tokens.muted },
            {
              text: selectedPlugin
                ? `contributed by plugin ${selectedPlugin.name} ${glyph("separator")} ${selectedPlugin.enabled ? "enabled" : "disabled"}`
                : "operator-declared server",
              fg: selectedPlugin?.enabled === false ? tokens.warn : tokens.muted,
            },
            {
              text: "Install/enable, select, and test are separate actions; test performs no write.",
              fg: tokens.muted,
            },
          ]}
        />
      </box>
    );
  }

  return (
    <LevelHost
      host={host}
      editor={fe}
      levels={[
        { title: "Feature backends", body: rootBody },
        {
          title: () =>
            panel() === "plans"
              ? "Plan provider"
              : panel() === "memory"
                ? "Memory provider"
                : "Tasks provider",
          body: () =>
            panel() === "plans" ? plansBody() : panel() === "memory" ? memoryBody() : tasksBody(),
        },
      ]}
    />
  );
}
