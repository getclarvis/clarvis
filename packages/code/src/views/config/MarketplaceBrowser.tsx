import type { JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import type { PluginSource } from "@clarvis/protocol";
import { AGENTS_DIR, AGENTS_PLUGINS_DIR, CLARVIS_DIR } from "@clarvis/paths";
import type { MarketplaceListing, MarketplaceSource } from "../../adapters/marketplace.ts";
import type { PluginView } from "../../adapters/plugins.ts";
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
  ErrorBanner,
  LoadingHint,
  SectionHeader,
  SelectableRow,
  ViewFrame,
} from "./view-host.tsx";

/** Data and lifecycle actions needed by the unified plugin marketplace. */
export interface MarketplaceBrowserDeps {
  listings: () => MarketplaceListing[];
  sources: () => MarketplaceSource[];
  plugins: () => PluginView[];
  environment: () => string | undefined;
  loading: () => boolean;
  install: (listing: MarketplaceListing) => Promise<string>;
  installUrl: (url: string, source: PluginSource) => Promise<string>;
  configure: (plugin: PluginView) => void;
  update: (plugin: PluginView) => Promise<string>;
  uninstall: (plugin: PluginView) => Promise<string>;
  refresh: () => void;
  addSource: (url: string) => void;
  notify: (message: string, tone?: "success" | "warn" | "error") => void;
}

type MarketplaceRow =
  { kind: "plugin"; plugin: PluginView } | { kind: "listing"; listing: MarketplaceListing };

type MarketplaceCollection =
  | { kind: "all"; id: "all"; label: "All" }
  | { kind: "installed"; id: "installed"; label: string }
  | { kind: "source"; id: string; label: string; source: MarketplaceSource }
  | { kind: "workspace"; id: "workspace"; label: string }
  | { kind: "add"; id: "add"; label: "Add Marketplace" };

function pluginId(plugin: PluginView): string {
  return `${plugin.scope}/${plugin.source}/${plugin.name}`;
}

function displayName(row: MarketplaceRow): string {
  return row.kind === "plugin"
    ? (row.plugin.displayName ?? row.plugin.name)
    : (row.listing.displayName ?? row.listing.name);
}

function sourceLabel(source: MarketplaceSource): string {
  const presented = source.marketplace?.displayName ?? source.marketplace?.name;
  if (presented !== undefined && presented.trim() !== "") return presented;
  const normalized = source.url.replace(/\/$/, "");
  const last = normalized
    .split("/")
    .at(-1)
    ?.replace(/\.git$/, "");
  return last && last !== "marketplace" ? last : normalized;
}

function rowTone(row: MarketplaceRow): "ok" | "error" | "warn" | "pending" {
  if (row.kind === "listing") return row.listing.installable ? "pending" : "warn";
  if (row.plugin.error !== undefined) return "error";
  return row.plugin.enabled ? "ok" : "pending";
}

function rowLifecycle(row: MarketplaceRow): string {
  if (row.kind === "listing") return `Available ${glyph("separator")} ${row.listing.marketplace}`;
  if (row.plugin.error !== undefined)
    return `Unavailable ${glyph("separator")} ${pluginId(row.plugin)}`;
  return row.plugin.enabled
    ? `Active ${glyph("separator")} current Environment`
    : `Installed ${glyph("separator")} not in current Environment`;
}

function contributionSummary(plugin: PluginView): string {
  const contributions = plugin.contributions;
  const parts = [
    [contributions.agents.length, "agents"],
    [contributions.skills.length, "skills"],
    [contributions.servers.length, "MCP servers"],
    [contributions.hooks, "hooks"],
    [contributions.capabilityExecutables.length, "services"],
  ] as const;
  return (
    parts
      .filter(([count]) => count > 0)
      .map(([count, label]) => `${count} ${label}`)
      .join(` ${glyph("separator")} `) || "no contributions"
  );
}

function haystack(row: MarketplaceRow): string {
  if (row.kind === "listing") {
    const listing = row.listing;
    return [
      listing.name,
      listing.displayName,
      listing.description,
      listing.category,
      listing.marketplace,
      listing.notes.join(" "),
    ]
      .filter(Boolean)
      .join(" ");
  }
  const plugin = row.plugin;
  return [
    plugin.name,
    plugin.displayName,
    plugin.description,
    plugin.shortDescription,
    plugin.scope,
    plugin.source,
    plugin.contributions.skills.join(" "),
    plugin.contributions.agents.join(" "),
    plugin.contributions.servers.join(" "),
  ]
    .filter(Boolean)
    .join(" ");
}

function sortRows(rows: MarketplaceRow[]): MarketplaceRow[] {
  return rows.sort((left, right) => {
    const byName = displayName(left).localeCompare(displayName(right));
    if (byName !== 0 || left.kind === right.kind) return byName;
    return left.kind === "plugin" ? -1 : 1;
  });
}

/** Two-dimensional marketplace browser with Environment-aware plugin lifecycle. */
export function MarketplaceBrowser(host: ViewHost, deps: MarketplaceBrowserDeps): JSX.Element {
  const dimensions = useTerminalDimensions();
  const editor = createFieldEditor(host.interaction, host.active);
  const [term, setTerm] = createSignal("");
  const [sel, setSel] = createSignal(0);
  const [collectionIndex, setCollectionIndex] = createSignal(0);
  const [detailOpen, setDetailOpen] = createSignal(false);
  const [operation, setOperation] = createSignal<string>();
  const [operationStartedAt, setOperationStartedAt] = createSignal<number>();
  let detailScroll: ScrollBoxRenderable | undefined;

  useSpinnerClock(() => operation() !== undefined && host.active());

  const installedNames = createMemo(() => new Set(deps.plugins().map((plugin) => plugin.name)));
  const catalogRows = createMemo<MarketplaceRow[]>(() =>
    sortRows([
      ...deps.plugins().map((plugin): MarketplaceRow => ({ kind: "plugin", plugin })),
      ...deps
        .listings()
        .filter((listing) => !installedNames().has(listing.name))
        .map((listing): MarketplaceRow => ({ kind: "listing", listing })),
    ]),
  );
  const collections = createMemo<MarketplaceCollection[]>(() => {
    const workspaceCount = deps.plugins().filter((plugin) => plugin.scope === "workspace").length;
    return [
      { kind: "all", id: "all", label: "All" },
      { kind: "installed", id: "installed", label: `Installed (${deps.plugins().length})` },
      ...deps.sources().map((source): MarketplaceCollection => ({
        kind: "source",
        id: `source:${source.url}`,
        label: sourceLabel(source),
        source,
      })),
      { kind: "workspace", id: "workspace", label: `Workspace (${workspaceCount})` },
      { kind: "add", id: "add", label: "Add Marketplace" },
    ];
  });
  const currentCollection = (): MarketplaceCollection =>
    collections()[clampListIndex(collectionIndex(), collections().length)]!;
  const collectionRows = createMemo<MarketplaceRow[]>(() => {
    const collection = currentCollection();
    if (collection.kind === "all") return catalogRows();
    if (collection.kind === "installed") {
      return sortRows(deps.plugins().map((plugin) => ({ kind: "plugin" as const, plugin })));
    }
    if (collection.kind === "workspace") {
      return sortRows(
        deps
          .plugins()
          .filter((plugin) => plugin.scope === "workspace")
          .map((plugin) => ({ kind: "plugin" as const, plugin })),
      );
    }
    if (collection.kind === "add") return [];
    const sourceListings = deps
      .listings()
      .filter((listing) => listing.marketplaceUrl === collection.source.url);
    const sourceNames = new Set(sourceListings.map((listing) => listing.name));
    return sortRows([
      ...deps
        .plugins()
        .filter((plugin) => sourceNames.has(plugin.name))
        .map((plugin) => ({ kind: "plugin" as const, plugin })),
      ...sourceListings
        .filter((listing) => !installedNames().has(listing.name))
        .map((listing) => ({ kind: "listing" as const, listing })),
    ]);
  });
  const rows = createMemo(() => {
    const value = term().trim();
    return value === "" ? collectionRows() : fuzzyFilter(collectionRows(), value, haystack);
  });
  const selected = (): MarketplaceRow | undefined => rows()[clampListIndex(sel(), rows().length)];
  const selectedPlugin = (): PluginView | undefined => {
    const row = selected();
    return row?.kind === "plugin" ? row.plugin : undefined;
  };
  const available = (): number =>
    deps.listings().filter((listing) => listing.installable && !installedNames().has(listing.name))
      .length;
  const maxLines = (): number => Math.max(1, dimensions().height - 12);
  const activeCount = (): number => deps.plugins().filter((plugin) => plugin.enabled).length;

  const collectionWindow = createMemo(() => {
    const all = collections();
    const current = clampListIndex(collectionIndex(), all.length);
    const slots = Math.max(3, Math.min(all.length, Math.floor((dimensions().width - 12) / 18)));
    const start = Math.max(0, Math.min(current - Math.floor(slots / 2), all.length - slots));
    return {
      before: start,
      after: all.length - (start + slots),
      visible: all.slice(start, start + slots).map((collection, offset) => ({
        collection,
        index: start + offset,
      })),
    };
  });

  const run = (label: string, task: () => Promise<string>): void => {
    if (operation() !== undefined) return;
    setOperationStartedAt(Date.now());
    setOperation(label);
    detachObserved(
      `marketplace_${label.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`,
      async () => {
        try {
          deps.notify(await task(), "success");
        } finally {
          setOperation(undefined);
          setOperationStartedAt(undefined);
        }
      },
      (error) => {
        setOperation(undefined);
        setOperationStartedAt(undefined);
        deps.notify(errorText(error), "warn");
      },
    );
  };

  const search = (): void =>
    editor.start("search plugins", term(), setTerm, { alwaysCommit: true });

  const addMarketplace = (): void =>
    editor.start("marketplace Git URL", "", (url) => {
      if (url.trim() !== "") deps.addSource(url.trim());
    });

  const openGitInstall = (): void =>
    editor.startPick(
      "install inventory",
      [
        {
          label: `${AGENTS_DIR}/${AGENTS_PLUGINS_DIR}`,
          value: "agents",
          detail: "recommended shared Agent Plugin inventory",
        },
        {
          label: `${CLARVIS_DIR}/${AGENTS_PLUGINS_DIR}`,
          value: "clarvis",
          detail: "Clarvis-native inventory",
        },
      ],
      (source) =>
        editor.start("plugin Git URL", "", (url) => {
          if (url.trim() !== "") {
            run("Installing plugin", () => deps.installUrl(url.trim(), source as PluginSource));
          }
        }),
    );

  const changeCollection = (delta: number): void => {
    const count = collections().length;
    if (count === 0) return;
    const next = (clampListIndex(collectionIndex(), count) + delta + count) % count;
    setCollectionIndex(next);
    setSel(0);
    setDetailOpen(false);
  };

  const openPrimary = (): void => {
    if (operation() !== undefined) return;
    if (currentCollection().kind === "add") {
      addMarketplace();
      return;
    }
    if (selected() !== undefined) setDetailOpen(true);
  };

  const runDetailPrimary = (): void => {
    if (operation() !== undefined) return;
    const row = selected();
    if (row === undefined) return;
    if (row.kind === "listing") {
      if (row.listing.installable) {
        run(`Installing ${row.listing.name}`, () => deps.install(row.listing));
      }
      return;
    }
    deps.configure(row.plugin);
  };

  const update = (): void => {
    const plugin = selectedPlugin();
    if (plugin === undefined) return;
    if (plugin.scope === "workspace") {
      deps.notify(
        `${plugin.name} lives in this workspace ${glyph("emDash")} update it in the repository`,
        "warn",
      );
      return;
    }
    detachObserved("marketplace_update_confirm", () =>
      host
        .confirm({
          message: `Update ${plugin.name}?`,
          detail: [
            "The plugin may change its skills, MCP servers, hooks or executable services.",
            "The new content enters only after this run is idle and the kernel reconnects.",
          ],
          confirmLabel: "review and update",
          cancelLabel: "keep current version",
        })
        .then((approved) => {
          if (approved) run(`Updating ${plugin.name}`, () => deps.update(plugin));
        }),
    );
  };

  const uninstall = (): void => {
    const plugin = selectedPlugin();
    if (plugin === undefined) return;
    if (plugin.scope === "workspace") {
      deps.notify(
        `${plugin.name} lives in this workspace ${glyph("emDash")} remove it from the repository`,
        "warn",
      );
      return;
    }
    detachObserved("marketplace_uninstall_confirm", () =>
      host
        .confirm({
          message: `Uninstall ${plugin.name}?`,
          danger: true,
          detail: [`deletes ${plugin.dir}`],
          confirmLabel: "uninstall",
          cancelLabel: "keep",
        })
        .then((approved) => {
          if (!approved) return;
          run(`Uninstalling ${plugin.name}`, async () => {
            const message = await deps.uninstall(plugin);
            setDetailOpen(false);
            return message;
          });
        }),
    );
  };

  const spec = (): LevelSpec => {
    if (detailOpen()) {
      return {
        scroll: () => detailScroll,
        verbs: [
          {
            id: "marketplace.detail.primary",
            key: "return",
            label:
              selected()?.kind === "listing" ? "install and activate" : "configure Environment",
            run: runDetailPrimary,
            when: () => {
              const row = selected();
              return (
                operation() === undefined &&
                (row?.kind === "plugin" || row?.listing.installable === true)
              );
            },
            hintGroup: "primary",
            hintPriority: 95,
            essential: true,
          },
          {
            id: "marketplace.environment.configure",
            key: "e",
            label: "configure Environment",
            run: () => {
              const plugin = selectedPlugin();
              if (plugin !== undefined) deps.configure(plugin);
            },
            when: () => selectedPlugin() !== undefined && operation() === undefined,
          },
          {
            id: "marketplace.plugin.update",
            key: "u",
            label: "update",
            run: update,
            when: () => selectedPlugin() !== undefined && operation() === undefined,
          },
          {
            id: "marketplace.plugin.uninstall",
            key: "d",
            label: "uninstall",
            run: uninstall,
            when: () => selectedPlugin() !== undefined && operation() === undefined,
          },
        ],
        escape: { label: "back to plugins", run: () => setDetailOpen(false) },
      };
    }
    return {
      nav: {
        count: () => rows().length,
        index: sel,
        setIndex: setSel,
        lettersNav: false,
        activate: {
          label: "view details",
          run: openPrimary,
          when: () => selected() !== undefined && operation() === undefined,
        },
      },
      verbs: [
        {
          id: "marketplace.collection.previous",
          key: "left",
          label: "previous marketplace",
          run: () => changeCollection(-1),
          hintGroup: "navigation",
          hintPriority: 90,
          essential: true,
        },
        {
          id: "marketplace.collection.next",
          key: "right",
          label: "next marketplace",
          run: () => changeCollection(1),
          hintGroup: "navigation",
          hintPriority: 90,
          essential: true,
        },
        {
          id: "marketplace.add.primary",
          key: "return",
          label: "add marketplace",
          run: addMarketplace,
          when: () => currentCollection().kind === "add" && operation() === undefined,
          hintGroup: "primary",
          hintPriority: 95,
          essential: true,
        },
        {
          id: "marketplace.search",
          key: "/",
          label: "search collection",
          run: search,
          when: () => currentCollection().kind !== "add",
          hintGroup: "navigation",
          hintPriority: 75,
        },
        {
          id: "marketplace.search.clear",
          key: "x",
          label: "clear search",
          run: () => setTerm(""),
          when: () => term() !== "",
        },
        {
          id: "marketplace.install.url",
          key: "g",
          label: "install Git URL",
          run: openGitInstall,
          when: () => operation() === undefined,
        },
        {
          id: "marketplace.refresh",
          key: "ctrl+r",
          label: "refresh",
          run: deps.refresh,
          hintPriority: 30,
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
    setSel((current) => clampListIndex(current + delta, rows().length));
  };

  const footerStatus = () => {
    const label = operation();
    if (label === undefined) return undefined;
    const running = tone("running", spinnerChar());
    const startedAt = operationStartedAt();
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

  function collectionBar(): JSX.Element {
    const window = collectionWindow();
    return (
      <text flexShrink={0} wrapMode="none" truncate>
        <Show when={window.before > 0}>
          <span style={{ fg: tokens.muted }}>{`${glyph("arrowLeft")} ${window.before}  `}</span>
        </Show>
        <For each={window.visible}>
          {(entry) => (
            <span
              style={{
                fg: entry.index === collectionIndex() ? tokens.accent : tokens.muted,
                attributes: entry.index === collectionIndex() ? 1 : 0,
              }}
            >
              {`${entry.index === collectionIndex() ? "[" : " "}${entry.collection.label}${
                entry.index === collectionIndex() ? "]" : " "
              }  `}
            </span>
          )}
        </For>
        <Show when={window.after > 0}>
          <span style={{ fg: tokens.muted }}>{`${window.after} ${glyph("arrowRight")}`}</span>
        </Show>
      </text>
    );
  }

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
              <text visible={overflow.visible()} fg={tokens.muted}>
                {`  ${glyph("arrowUp")} ${overflow.count()} more`}
              </text>
            )}
            row={(slot) => {
              const row = slot.item;
              return (
                <SelectableRow selected={slot.selected()} visible={slot.visible()}>
                  <span style={{ fg: tone(row() ? rowTone(row()!) : "pending").fg }}>
                    {tone(row() ? rowTone(row()!) : "pending").glyph + " "}
                  </span>
                  <span style={{ fg: tokens.fg }}>{row() ? displayName(row()!) : ""}</span>
                  <span style={{ fg: tokens.muted }}>
                    {row() ? `  ${rowLifecycle(row()!)}` : ""}
                  </span>
                </SelectableRow>
              );
            }}
            below={(overflow) => (
              <text visible={overflow.visible()} fg={tokens.muted}>
                {`  ${glyph("arrowDown")} ${overflow.count()} more`}
              </text>
            )}
          />
        </Show>
        <Show when={rows().length === 0 && deps.loading()}>
          <LoadingHint text="fetching marketplaces" />
        </Show>
        <Show when={rows().length === 0 && !deps.loading()}>
          <EmptyHint
            text={term() === "" ? "No plugins in this collection" : `No matches for "${term()}"`}
            hint="Use left and right to browse another marketplace, or add a source."
          />
        </Show>
      </box>
    );
  }

  function pluginDetail(plugin: PluginView): JSX.Element {
    const contributions = plugin.contributions;
    return (
      <box flexDirection="column">
        <text fg={tokens.accent} wrapMode="word">
          <b>{plugin.displayName ?? plugin.name}</b>
        </text>
        <text fg={tokens.fg} wrapMode="word">
          {plugin.shortDescription ?? plugin.description ?? "Installed plugin"}
        </text>
        <Show when={plugin.shortDescription && plugin.description !== plugin.shortDescription}>
          <text fg={tokens.muted} wrapMode="word">
            {plugin.description}
          </text>
        </Show>
        <SectionHeader label="Environment" />
        <text
          fg={plugin.error ? tokens.del : plugin.enabled ? tokens.add : tokens.warn}
          wrapMode="word"
        >
          {plugin.error ??
            (plugin.enabled
              ? `Active in ${deps.environment() ?? "the current Environment"}`
              : `Installed, but not selected by ${deps.environment() ?? "the current Environment"}`)}
        </text>
        <text fg={tokens.muted} wrapMode="word">
          {plugin.enabled
            ? "Enter opens the Environment composer."
            : "Enter adds this exact plugin origin through the Environment composer."}
        </text>
        <text fg={tokens.muted}>{`inventory  ${plugin.scope}/${plugin.source}`}</text>
        <Show when={plugin.version}>
          <text fg={tokens.muted}>{`version    ${plugin.version}`}</text>
        </Show>
        <SectionHeader label="Capabilities" />
        <text fg={tokens.muted}>{contributionSummary(plugin)}</text>
        <For each={contributions.agents}>
          {(name) => <text fg={tokens.warn}>{`agent      ${name}`}</text>}
        </For>
        <For each={contributions.brokenAgents}>
          {(name) => <text fg={tokens.del}>{`broken     ${name}`}</text>}
        </For>
        <For each={contributions.skills}>
          {(name) => <text fg={tokens.fg}>{`skill      /${name}`}</text>}
        </For>
        <For each={contributions.servers}>
          {(name) => <text fg={tokens.warn}>{`MCP server ${name}`}</text>}
        </For>
        <For each={contributions.capabilityExecutables}>
          {(service) => (
            <text
              fg={tokens.warn}
              wrapMode="word"
            >{`service    ${service.capability}: ${[service.command, ...service.args].join(" ")}`}</text>
          )}
        </For>
        <For each={contributions.skillPlanPolicies ?? []}>
          {(policy) => (
            <text
              fg={policy.mode === "review" ? tokens.warn : tokens.muted}
            >{`policy     /${policy.skill} ${glyph("arrowRight")} plans:${policy.mode}`}</text>
          )}
        </For>
        <SectionHeader label="Security" />
        <text fg={tokens.muted}>{`hooks      ${contributions.hooks} active with this plugin`}</text>
        <For each={contributions.executables}>
          {(command) => <text fg={tokens.warn} wrapMode="word">{`executes   ${command}`}</text>}
        </For>
        <SectionHeader label="Source" />
        <Show when={plugin.installSource}>
          <text fg={tokens.muted} wrapMode="word">{`repository ${plugin.installSource}`}</text>
        </Show>
        <Show when={plugin.revision}>
          <text fg={tokens.muted}>{`revision   ${plugin.revision}`}</text>
        </Show>
        <text fg={tokens.muted} wrapMode="word">{`path       ${plugin.dir}`}</text>
        <For each={plugin.notes ?? []}>
          {(note) => <text fg={tokens.warn} wrapMode="word">{`${glyph("warning")} ${note}`}</text>}
        </For>
      </box>
    );
  }

  function listingDetail(listing: MarketplaceListing): JSX.Element {
    return (
      <box flexDirection="column">
        <text fg={tokens.accent} wrapMode="word">
          <b>{listing.displayName ?? listing.name}</b>
        </text>
        <text fg={tokens.fg} wrapMode="word">
          {listing.description}
        </text>
        <SectionHeader label="Install" />
        <text fg={listing.installable ? tokens.accent2 : tokens.muted} wrapMode="word">
          {listing.installable
            ? `Enter installs the plugin and adds it to ${deps.environment() ?? "the current Environment"}.`
            : "This source cannot be installed by the current host."}
        </text>
        <text fg={tokens.muted} wrapMode="word">
          Installation approves the complete plugin: agents, skills, MCP servers, hooks and
          services.
        </text>
        <SectionHeader label="Source" />
        <text fg={tokens.muted} wrapMode="word">{`marketplace  ${listing.marketplace}`}</text>
        <text fg={tokens.muted} wrapMode="word">{`repository   ${listing.source}`}</text>
        <Show when={listing.category}>
          <text fg={tokens.muted}>{`category     ${listing.category}`}</text>
        </Show>
        <Show when={listing.homepage}>
          <text fg={tokens.muted} wrapMode="word">{`homepage     ${listing.homepage}`}</text>
        </Show>
        <For each={listing.notes}>
          {(note) => <text fg={tokens.warn} wrapMode="word">{`${glyph("warning")} ${note}`}</text>}
        </For>
      </box>
    );
  }

  function detail(): JSX.Element {
    const row = selected();
    if (row === undefined) return <EmptyHint text="Nothing selected" />;
    return row.kind === "plugin" ? pluginDetail(row.plugin) : listingDetail(row.listing);
  }

  function addMarketplaceView(): JSX.Element {
    return (
      <box flexDirection="column" flexGrow={1} minHeight={0}>
        <text fg={tokens.accent2} wrapMode="word">
          Add a marketplace from a Git repository
        </text>
        <text fg={tokens.muted} wrapMode="word">
          Its plugins become available in this browser. Nothing is installed or activated yet.
        </text>
        <SectionHeader label="Expected content" />
        <text fg={tokens.muted} wrapMode="word">
          The repository must publish marketplace.json or .agents/marketplace.json.
        </text>
        <text fg={tokens.muted} wrapMode="word">
          Enter starts the source field. Use g when you already have one direct plugin Git URL.
        </text>
      </box>
    );
  }

  const currentSourceError = (): MarketplaceSource | undefined => {
    const collection = currentCollection();
    if (collection.kind === "source" && collection.source.error !== undefined) {
      return collection.source;
    }
    return collection.kind === "all"
      ? deps.sources().find((source) => source.error !== undefined)
      : undefined;
  };

  return (
    <ViewFrame
      host={host}
      title="Plugins"
      unscoped
      purpose="Browse marketplaces and compose the current Environment"
      mutationContract="Install approves the complete plugin and activates it through the current Environment"
      footerStatus={footerStatus}
    >
      <Show when={currentSourceError()}>
        <ErrorBanner
          text={`${currentSourceError()!.url}: ${currentSourceError()!.error ?? "unknown source error"}`}
        />
      </Show>
      <text fg={tokens.muted} flexShrink={0} wrapMode="none" truncate>
        {`${activeCount()} active ${glyph("separator")} ${deps.plugins().length} installed ${glyph("separator")} ${available()} available ${glyph("separator")} Environment ${deps.environment() ?? "loading"}`}
      </text>
      {collectionBar()}
      <Show when={currentCollection().kind !== "add"}>
        <text
          fg={term() === "" ? tokens.muted : tokens.accent2}
          flexShrink={0}
          wrapMode="none"
          truncate
        >
          {term() === "" ? "/ Search this collection" : `/ ${term()}`}
        </text>
      </Show>
      <Show when={!detailOpen() && currentCollection().kind !== "add" && selected()}>
        <text fg={tokens.accent2} flexShrink={0}>
          {`Enter ${glyph("arrowRight")} view plugin details`}
        </text>
      </Show>
      <Show
        when={detailOpen()}
        fallback={currentCollection().kind === "add" ? addMarketplaceView() : list()}
      >
        <scrollbox
          ref={(element: ScrollBoxRenderable) => (detailScroll = element)}
          flexGrow={1}
          minHeight={0}
          verticalScrollbarOptions={scrollbarOptions()}
        >
          {detail()}
        </scrollbox>
      </Show>
      <Show when={editor.editing()}>{editor.EditInput()}</Show>
      {editor.PickerInput()}
    </ViewFrame>
  );
}
