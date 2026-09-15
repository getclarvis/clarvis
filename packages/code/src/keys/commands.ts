import { createSignal } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import type { KeyEvent, Renderable } from "@opentui/core";
import type { Command, Keymap } from "@opentui/keymap";
import { fuzzyFilter, fuzzyFieldMatch } from "../core/fuzzy.ts";
import { compactSequence, commandKeyLabel } from "./keyspec.ts";
import type { Interaction } from "./interaction.ts";
import { uiCommand, type ActionHintGroup, type ActionSurface } from "./actions.ts";
import { diagnosticCount } from "../core/diagnostic-events.ts";

type OpenTuiKeymap = Keymap<Renderable, KeyEvent>;
type OpenTuiCommand = Command<Renderable, KeyEvent>;

/** Settings scope a view or the provider/agent lists currently target. */
export type Scope = "global" | "workspace";
type Category = "action" | "view";

/** A router can refuse invalid input while preserving the composer's exact draft. */
export type CommandRouteResult = boolean | "block";

/** Renders a view command's body for the given {@link ViewHost}. */
export type ViewFactory = (host: ViewHost) => JSX.Element;

/** Parameters for a confirmation prompt shown via {@link ViewHost.confirm}. */
export interface ConfirmRequest {
  message: string;
  danger?: boolean;
  detail?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
}

/** Navigation, scope, dirty-tracking and save/cancel services a view command's body receives. */
export interface ViewHost {
  interaction: Interaction;
  /** Whether this view is the visible, keyboard-owning frame at the top of the view stack. */
  active: Accessor<boolean>;
  close(): void;
  dispatch(name: string): void;
  level: {
    depth: Accessor<number>;
    push(title: string): void;
    pop(): boolean;
    retitle(title: string): void;
  };
  breadcrumb: Accessor<string[]>;
  scope: Accessor<Scope>;
  toggleScope(): void;
  bindScope(opts: { mode: "reload" | "retarget"; load?: () => void }): void;
  dirty: Accessor<boolean>;
  markDirty(value?: boolean): void;
  onSave(fn: () => void | Promise<void>): void;
  onCancel(fn: () => void): void;
  confirm(opts: ConfirmRequest): Promise<boolean>;
  pendingConfirm: Accessor<ConfirmRequest | null>;
}

/** Whether a command is reachable through a literal `/token` or only through another route. */
export type Surface = "slash" | "internal";
/** Slash/Help section a command sorts into. */
export type Group = "actions" | "navigate" | "skills" | "mcp";
/** Hub that owns a command's destination, for grouping under `command-groups.ts`'s hub parents. */
export type Parent = "settings" | "sessions" | "extensions" | "inspect";

interface CommandDefBase {
  name: string;
  title: string;
  desc?: string;
  slash?: string | string[] | false;
  /** Whether this command is reachable through a literal `/token` or only through another route. */
  surface: Surface;
  /** Slash/Help section this command sorts into. */
  group: Group;
  /** Hub that owns this destination — informational, and (for the hub parents in `command-groups.ts`) hides the command from the top-level `/` list. */
  parent?: Parent;
  namespace?: string;
  /** Action-discovery projections. Defaults from `surface`; footer inclusion is always explicit. */
  actionSurfaces?: readonly ActionSurface[];
  footerLabel?: string;
  hintPriority?: number;
  hintGroup?: ActionHintGroup;
  essential?: boolean;
  enabled?: () => boolean;
  /** Declared positional arguments — the popup shows them as inline usage hints. */
  args?: PromptArgSpec[];
  /** Named subcommands (`/token <name>`) — shown as inline choice hints and routed by {@link CommandDefBase.route}. */
  subcommands?: SubcommandSpec[];
  /**
   * Optional router for a `/token <args>` submission. Receives the argument tail
   * and returns `true` when it fully handled the line (so the plain command
   * `run`/`view` is skipped). Return `false` to fall through to the normal open.
   * Return `"block"` after a reported validation error to preserve the composer draft.
   */
  route?: (args: string) => CommandRouteResult;
}

/** One named subcommand of a command, surfaced as an inline choice hint under `/token `. */
export interface SubcommandSpec {
  name: string;
  desc?: string;
}

/** One positional argument of an MCP/skill prompt command. */
export interface PromptArgSpec {
  name: string;
  description?: string;
  required?: boolean;
}

interface PromptSpec {
  name: string;
  description?: string;
  arguments?: PromptArgSpec[];
  /**
   * A skill's declared display name, shown in place of its local invocation name.
   * The slash token and the command name are unaffected, so both stay
   * searchable and the invocation key never changes.
   */
  displayName?: string;
}

interface ActionCommandDef extends CommandDefBase {
  category?: "action";
  run: () => void | Promise<void>;
}

interface ViewCommandDef extends CommandDefBase {
  category?: "view";
  view: ViewFactory;
}

/** A fuzzy-match hit location for one field of a command entry in slash autocomplete. */
export interface CommandMatch {
  field: "title" | "name" | "slash";
  text: string;
  positions: number[];
}

/** Read-only projection of a registered command for slash and Help rendering. */
export interface CommandEntryView {
  name: string;
  title: string;
  desc?: string;
  category: Category;
  slashes: string[];
  surface: Surface;
  group: Group;
  parent?: Parent;
  namespace?: string;
  args: PromptArgSpec[];
  subcommands: SubcommandSpec[];
  keyHint: string;
  match?: CommandMatch;
  /**
   * Whether this command can act right now, or `undefined` when it always can.
   *
   * @remarks The `/` list drops a command that refuses rather than offering a
   *   row that does nothing — invariant 8, "no silent no-op is advertised".
   *   A function keeps evaluation with the active consumer instead of making
   *   command registration reactive.
   */
  canAct?: () => boolean;
}

interface KeyCommandRow {
  key: string;
  desc: string;
}

/** One category of key-command rows, shown together in a keybindings help view. */
export interface KeyCommandGroup {
  category: string;
  rows: KeyCommandRow[];
}

/** Callbacks invoked by the built-in session/status/export commands {@link createCommands} registers. */
export interface CommandEffects {
  clearSession(): void;
  status(): void;
  exportSession(): void;
}

/** A view route mounted underneath a deep-linked child so Escape has a real page to return to. */
export interface ViewRoute {
  name: string;
  factory: ViewFactory;
  scope?: Scope;
}

interface ViewOpenOptions {
  parent?: ViewRoute;
  scope?: Scope;
}

/** Callbacks {@link createCommands} calls to open a view, dismiss it, or report a command failure. */
export interface CommandUi {
  openView(name: string, view: ViewFactory, opts?: ViewOpenOptions): void;
  dismiss(): void;
  commandFailed(name: string, error: unknown): void;
}

/** A lifecycle-bound set of command registrations. */
export interface CommandScope {
  registerAction(def: ActionCommandDef): () => void;
  registerView(def: ViewCommandDef): () => void;
  promptCommand(server: string, prompt: PromptSpec, run: () => void | Promise<void>): () => void;
  /**
   * Register a skill as a `/<local>` slash command.
   *
   * @param run - the skill's handler, receiving the argument tail typed after the
   *   slash token (the empty string when invoked from a keybinding).
   */
  skillCommand(
    local: string,
    prompt: PromptSpec,
    run: (args: string) => void | Promise<void>,
  ): () => void;
  /** Unregister every command owned by this scope. Safe to call more than once. */
  dispose(): void;
}

/** Command registry API for registering, running and listing action/view commands. */
export interface Commands extends CommandScope {
  /** Create a child owner for one feature or mounted application tree. */
  scope(): CommandScope;
  runCommand(name: string): void;
  /** Route a `/token <args>` submission through the command's {@link CommandDefBase.route}; returns whether it handled the line. */
  route(name: string, args: string): CommandRouteResult;
  entries(term?: string): CommandEntryView[];
  /**
   * A counter bumped whenever a command is registered or unregistered.
   *
   * @remarks The registry is a plain `Map`, so nothing that reads {@link entries}
   *   is reactive on its own. A consumer that caches anything derived from the
   *   registry — the autocomplete provider list, above all — must read this, or
   *   it will never see the commands that arrive after boot: skills and MCP
   *   prompts are registered asynchronously once the client connects.
   */
  revision: Accessor<number>;
  keyCommandGroups(): KeyCommandGroup[];
  viewFactory(name: string): ViewFactory | undefined;
}

interface Registered {
  name: string;
  title: string;
  desc?: string;
  category: Category;
  slashes: string[];
  surface: Surface;
  group: Group;
  parent?: Parent;
  namespace?: string;
  args: PromptArgSpec[];
  subcommands: SubcommandSpec[];
  route?: (args: string) => CommandRouteResult;
  view?: ViewFactory;
  enabled?: () => boolean;
}

/**
 * The view command that lands on each {@link Parent}'s hub, where one exists.
 *
 * @remarks `sessions` and `inspect` are informational groupings with no hub
 *   screen of their own, so a destination under them has no level to return to
 *   and is opened as a root page.
 */
const HUB_COMMAND: Partial<Record<Parent, string>> = {
  settings: "settings.open",
  extensions: "extensions.open",
};

function normalizeSlash(token: string): string {
  const t = token.trim();
  return t.startsWith("/") ? t : "/" + t;
}

function resolveSlashes(slash: CommandDefBase["slash"]): string[] {
  if (slash === false || slash === undefined) return [];
  if (typeof slash === "string") return [normalizeSlash(slash)];
  return slash.map(normalizeSlash);
}

/**
 * Creates the {@link Commands} registry: wires the shared keymap, registers
 * the built-in session commands, and returns the API views and features use
 * to register/run/list commands.
 *
 * @param interaction - the keymap-backed interaction commands register into.
 * @param effects - callbacks for the built-in session commands.
 * @param ui - callbacks for opening views and reporting command failures.
 * @returns the registry handle.
 */
export function createCommands(
  interaction: Interaction,
  effects: CommandEffects,
  ui: CommandUi,
): Commands {
  const keymap: OpenTuiKeymap = interaction.keymap;
  const registry = new Map<string, Registered>();
  const order: string[] = [];
  const owned = new Set<() => void>();
  let disposed = false;
  const [revision, setRevision] = createSignal(0);
  let catalogRevision = -1;
  let catalogEnvironment: unknown;
  let catalog: CommandEntryView[] = [];
  const bumpRevision = (): void => {
    setRevision((n) => n + 1);
  };

  function runCommand(name: string): void {
    keymap.runCommand(name);
  }

  function keyHintFor(name: string): string {
    return commandKeyLabel(keymap, name) ?? "";
  }

  function keyCommandGroups(): KeyCommandGroup[] {
    const groups: KeyCommandGroup[] = [];
    const rowsByCategory = new Map<string, KeyCommandRow[]>();
    const seen = new Set<string>();
    for (const entry of keymap.getCommandEntries({ visibility: "registered" })) {
      const cmd = entry.command;
      if (entry.bindings.length === 0 || seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      const category = typeof cmd.category === "string" ? cmd.category : "other";
      if (category === "Text Editing") continue;
      const keys = [...new Set(entry.bindings.map((b) => compactSequence(b.sequence)))];
      const desc =
        typeof cmd.desc === "string"
          ? cmd.desc
          : typeof cmd.title === "string"
            ? cmd.title
            : cmd.name;
      let rows = rowsByCategory.get(category);
      if (!rows) {
        rows = [];
        rowsByCategory.set(category, rows);
        groups.push({ category, rows });
      }
      rows.push({ key: keys.join(" / "), desc });
    }
    return groups;
  }

  function register(reg: Registered, cmd: OpenTuiCommand): () => void {
    if (disposed) throw new Error("command registry is disposed");
    if (registry.has(reg.name)) throw new Error(`command already registered: ${reg.name}`);
    for (const slash of reg.slashes) {
      const owner = [...registry.values()].find((entry) => entry.slashes.includes(slash));
      if (owner) throw new Error(`slash command already registered: ${slash} (${owner.name})`);
    }
    registry.set(reg.name, reg);
    order.push(reg.name);
    let off: () => void;
    try {
      off = keymap.registerLayer({ commands: [cmd] });
    } catch (error) {
      registry.delete(reg.name);
      order.pop();
      throw error;
    }
    bumpRevision();
    let active = true;
    const unregister = (): void => {
      if (!active) return;
      active = false;
      owned.delete(unregister);
      try {
        off();
      } catch {}
      registry.delete(reg.name);
      const i = order.indexOf(reg.name);
      if (i >= 0) order.splice(i, 1);
      bumpRevision();
    };
    owned.add(unregister);
    return unregister;
  }

  /**
   * Invoke a command handler, funnelling a synchronous throw and a rejected
   * promise alike into {@link CommandUi.commandFailed}.
   *
   * @param name - the command's registry name, reported on failure.
   * @param run - the handler to invoke.
   */
  function dispatch(name: string, run: () => void | Promise<void>): void {
    try {
      void Promise.resolve(run()).catch((e: unknown) => ui.commandFailed(name, e));
    } catch (e) {
      ui.commandFailed(name, e);
    }
  }

  function registerAction(def: ActionCommandDef): () => void {
    const reg: Registered = {
      name: def.name,
      title: def.title,
      desc: def.desc,
      category: "action",
      slashes: resolveSlashes(def.slash),
      surface: def.surface,
      group: def.group,
      parent: def.parent,
      namespace: def.namespace,
      args: def.args ?? [],
      subcommands: def.subcommands ?? [],
      route: def.route,
      ...(def.enabled ? { enabled: def.enabled } : {}),
    };
    const cmd: OpenTuiCommand = uiCommand({
      id: def.name,
      title: def.title,
      description: def.desc ?? def.title,
      category: def.group,
      surfaces: def.actionSurfaces ?? ["full-help"],
      ...(def.footerLabel ? { footerLabel: def.footerLabel } : {}),
      ...(def.hintPriority === undefined ? {} : { hintPriority: def.hintPriority }),
      ...(def.hintGroup ? { hintGroup: def.hintGroup } : {}),
      ...(def.essential === undefined ? {} : { essential: def.essential }),
      ...(def.enabled ? { enabled: def.enabled } : {}),
      run: () => dispatch(def.name, def.run),
    });
    return register(reg, cmd);
  }

  function registerView(def: ViewCommandDef): () => void {
    const reg: Registered = {
      name: def.name,
      title: def.title,
      desc: def.desc,
      category: "view",
      slashes: resolveSlashes(def.slash),
      surface: def.surface,
      group: def.group,
      parent: def.parent,
      namespace: def.namespace,
      args: def.args ?? [],
      subcommands: def.subcommands ?? [],
      route: def.route,
      view: def.view,
      ...(def.enabled ? { enabled: def.enabled } : {}),
    };
    const cmd: OpenTuiCommand = uiCommand({
      id: def.name,
      title: def.title,
      description: def.desc ?? def.title,
      category: def.group,
      surfaces: def.actionSurfaces ?? ["full-help"],
      ...(def.footerLabel ? { footerLabel: def.footerLabel } : {}),
      ...(def.hintPriority === undefined ? {} : { hintPriority: def.hintPriority }),
      ...(def.hintGroup ? { hintGroup: def.hintGroup } : {}),
      ...(def.essential === undefined ? {} : { essential: def.essential }),
      ...(def.enabled ? { enabled: def.enabled } : {}),
      run: () => {
        try {
          const parent = parentRouteOf(def.parent);
          ui.openView(def.name, def.view, parent ? { parent } : undefined);
        } catch (e) {
          ui.commandFailed(def.name, e);
        }
      },
    });
    return register(reg, cmd);
  }

  function promptCommand(
    server: string,
    prompt: PromptSpec,
    run: () => void | Promise<void>,
  ): () => void {
    const name = `${server}:${prompt.name}`;
    return registerAction({
      name,
      title: prompt.name,
      desc: prompt.description ?? `${server} prompt`,
      namespace: server,
      slash: `/${name}`,
      surface: "slash",
      group: "mcp",
      args: prompt.arguments,
      run: () => run(),
    });
  }

  function slashTaken(slash: string): boolean {
    for (const r of registry.values()) if (r.slashes.includes(slash)) return true;
    return false;
  }

  function skillCommand(
    local: string,
    prompt: PromptSpec,
    run: (args: string) => void | Promise<void>,
  ): () => void {
    const slash = normalizeSlash(local);
    if (slashTaken(slash)) return () => {};
    const name = `skill.${local}`;
    return registerAction({
      name,
      title: prompt.displayName ?? local,
      desc: prompt.description ?? "skill",
      namespace: "skills",
      slash,
      surface: "slash",
      group: "skills",
      args: prompt.arguments,
      run: () => run(""),
      route: (args) => {
        dispatch(name, () => run(args));
        return true;
      },
    });
  }

  function route(name: string, args: string): CommandRouteResult {
    const fn = registry.get(name)?.route;
    return fn ? fn(args) : false;
  }

  /**
   * Whether `registered`'s own `enabled` predicate says it can act right now.
   *
   * @remarks A throwing predicate answers `true`. This is a display projection
   *   evaluated while slash suggestions are active, and it runs inside a Solid
   *   computation — so one predicate reaching a collaborator
   *   that is not there yet took the whole shell down rather than hiding one
   *   row. Failing open keeps the command reachable, which is the safer of the
   *   two wrong answers.
   */
  function canAct(registered: Registered): boolean {
    try {
      return registered.enabled!() !== false;
    } catch (error) {
      diagnosticCount(
        "command.enabled.threw",
        { command: registered.name, error },
        `command.enabled.threw.${registered.name}`,
      );
      return true;
    }
  }

  /** Reuses the structural command projection until registrations or keyboard bindings change. */
  function commandCatalog(): CommandEntryView[] {
    const currentRevision = revision();
    const environment = interaction.keyboardEnvironment?.();
    if (catalogRevision === currentRevision && catalogEnvironment === environment) return catalog;
    catalogRevision = currentRevision;
    catalogEnvironment = environment;
    catalog = order.map((name) => {
      const r = registry.get(name)!;
      return {
        name: r.name,
        title: r.title,
        desc: r.desc,
        category: r.category,
        slashes: r.slashes,
        surface: r.surface,
        group: r.group,
        parent: r.parent,
        namespace: r.namespace,
        args: r.args,
        subcommands: r.subcommands,
        keyHint: keyHintFor(r.name),
        ...(r.enabled === undefined ? {} : { canAct: () => canAct(r) }),
      };
    });
    return catalog;
  }

  function entries(term = ""): CommandEntryView[] {
    const all = commandCatalog();
    if (term.trim().length === 0) return all;
    const filtered = fuzzyFilter(all, term, (e) => [e.title, e.name, ...e.slashes].join(" "));
    return filtered.map((e) => {
      const fields: { field: CommandMatch["field"]; text: string }[] = [
        ...e.slashes.map((text) => ({ field: "slash" as const, text })),
        { field: "title", text: e.title },
        { field: "name", text: e.name },
      ];
      const hit = fuzzyFieldMatch(
        fields.map((f) => f.text),
        term,
      );
      return hit ? { ...e, match: { ...fields[hit.field]!, positions: hit.positions } } : e;
    });
  }

  function viewFactory(name: string): ViewFactory | undefined {
    return registry.get(name)?.view;
  }

  /**
   * The landing hub a `parent`-carrying destination should sit above.
   *
   * @remarks Seeded so Escape from a destination reached by *any* route lands on
   *   its hub, exactly as it does when the user walked in through the hub
   *   itself. The hub's own `openChild` already passed a parent route; opening
   *   the same destination from a direct route or a `/token` did not, so
   *   one Escape jumped two semantic levels — invariant 5, "Escape moves one
   *   semantic level". Doing it here rather than at each call site is what keeps
   *   a destination added later from quietly inheriting the old behaviour.
   */
  function parentRouteOf(parent: Parent | undefined): ViewRoute | undefined {
    if (parent === undefined) return undefined;
    const name = HUB_COMMAND[parent];
    if (name === undefined) return undefined;
    const factory = registry.get(name)?.view;
    return factory === undefined ? undefined : { name, factory };
  }

  function createScope(): CommandScope {
    if (disposed) throw new Error("command registry is disposed");
    const registrations = new Set<() => void>();
    let scopeDisposed = false;

    function own(off: () => void): () => void {
      if (scopeDisposed) {
        off();
        throw new Error("command scope is disposed");
      }
      let active = true;
      const release = (): void => {
        if (!active) return;
        active = false;
        registrations.delete(release);
        off();
      };
      registrations.add(release);
      return release;
    }

    return {
      registerAction: (def) => own(registerAction(def)),
      registerView: (def) => own(registerView(def)),
      promptCommand: (server, prompt, run) => own(promptCommand(server, prompt, run)),
      skillCommand: (local, prompt, run) => own(skillCommand(local, prompt, run)),
      dispose: () => {
        if (scopeDisposed) return;
        scopeDisposed = true;
        for (const off of [...registrations].reverse()) off();
        registrations.clear();
      },
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const off of [...owned].reverse()) off();
    owned.clear();
  }

  const commands: Commands = {
    registerAction,
    registerView,
    promptCommand,
    skillCommand,
    runCommand,
    route,
    entries,
    revision,
    keyCommandGroups,
    viewFactory,
    scope: createScope,
    dispose,
  };

  registerAction({
    name: "app.clear",
    title: "New session",
    desc: "Archive the current session and start fresh",
    slash: "/clear",
    surface: "slash",
    group: "actions",
    run: () => effects.clearSession(),
  });
  registerAction({
    name: "status.show",
    title: "Status",
    desc: "Agent, model, tokens and run state",
    slash: "/status",
    surface: "slash",
    group: "actions",
    parent: "sessions",
    run: () => effects.status(),
  });
  registerAction({
    name: "session.export",
    title: "Export transcript",
    desc: "Write the transcript to a file",
    slash: "/export",
    surface: "slash",
    group: "actions",
    parent: "sessions",
    run: () => effects.exportSession(),
  });

  return commands;
}
