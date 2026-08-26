import type { Accessor, JSX } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import type { ViewHost } from "../../keys/commands.ts";
import { clampListIndex } from "../../ui/patterns/list-navigation.ts";
import { registerLevel, verb, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import {
  bindLevelKeys,
  createFieldEditor,
  DetailLines,
  ErrorBanner,
  LoadingHint,
  SelectableList,
  SelectableRow,
  ViewFrame,
  type DetailRow,
} from "./view-host.tsx";
import type { MarketplaceListing, MarketplaceSource } from "../../adapters/marketplace.ts";

/** Data and actions {@link MarketplaceBrowser} needs from its host. */
export interface MarketplaceBrowserDeps {
  listings: Accessor<MarketplaceListing[]>;
  sources: Accessor<MarketplaceSource[]>;
  loading: Accessor<boolean>;
  install: (listing: MarketplaceListing) => void;
  refresh: () => void;
  /**
   * Add a marketplace by git URL.
   *
   * @remarks Without this the only way to configure one was to hand-edit
   *   `settings.json` and restart the kernel — a step the product named nowhere,
   *   which made the view a dead end for anyone who reached it.
   */
  addSource: (url: string) => void;
}

/**
 * The mark a listing carries in the list: installed, offered, or read-only
 * because this host has no way to install from the source it names.
 */
function rowGlyph(listing: MarketplaceListing): string {
  if (listing.installed) return glyph("success");
  return listing.installable ? glyph("pending") : glyph("warning");
}

/** The colour matching {@link rowGlyph}. */
function rowFg(listing: MarketplaceListing): string {
  if (listing.installed) return tokens.add;
  return listing.installable ? tokens.muted : tokens.warn;
}

/**
 * Read-only browser over plugin marketplace listings: pick a listing to
 * install it (it still needs enabling and approval before it runs), and
 * surfaces any source that failed to fetch.
 */
export function MarketplaceBrowser(host: ViewHost, deps: MarketplaceBrowserDeps): JSX.Element {
  const keymap = host.interaction.keymap;
  const [sel, setSel] = createSignal(0);
  const editor = createFieldEditor(host.interaction, host.active);

  const items = (): MarketplaceListing[] => deps.listings();
  const selected = (): MarketplaceListing | undefined =>
    items()[clampListIndex(sel(), items().length)];
  const broken = (): MarketplaceSource[] => deps.sources().filter((s) => s.error !== undefined);
  const installable = (): number => items().filter((l) => l.installable && !l.installed).length;

  /**
   * The one line stating what this whole catalog can do for the user.
   *
   * @remarks A listing that cannot be installed explains itself in the detail
   * pane, which is honest per row and useless across 196 of them: the user
   * scrolled a full screen of identical warnings to discover a fact one sentence
   * could have told them before they started.
   */
  const summary = (): string | undefined => {
    const total = items().length;
    if (total === 0) return undefined;
    const usable = installable();
    const head = `${String(total)} listing${total === 1 ? "" : "s"}`;
    if (usable === total) return head;
    if (usable > 0) return `${head} ${glyph("separator")} ${String(usable)} installable from here`;
    return (
      `${head} ${glyph("separator")} none can be installed from here. ` +
      `Each names a path inside its marketplace, and Clarvis installs from a git URL. ` +
      `A plugin's own repository can still be installed from Plugins.`
    );
  };

  /**
   * The one-line state a listing is in: installed, installable, or offered by a
   * source this host has no fetcher for.
   */
  const statusRow = (l: MarketplaceListing): DetailRow => {
    if (l.installed) return { text: `${glyph("success")} already installed`, fg: tokens.add };
    if (!l.installable) {
      return {
        text: `${glyph("warning")} cannot be installed from here; Clarvis installs a plugin from git.`,
        fg: tokens.warn,
      };
    }
    return {
      text: `${glyph("pending")} not installed; enabling and approval are still required after installation.`,
      fg: tokens.muted,
    };
  };

  const detailRows = (): DetailRow[] => {
    const l = selected();
    if (!l) return [];
    return [
      ...(l.displayName !== undefined ? [{ text: l.displayName, fg: tokens.fg }] : []),
      { text: l.description, fg: tokens.fg },
      { text: `source   ${l.source}`, fg: tokens.muted },
      ...(l.category !== undefined ? [{ text: `category ${l.category}`, fg: tokens.muted }] : []),
      ...(l.homepage !== undefined ? [{ text: `home     ${l.homepage}`, fg: tokens.muted }] : []),
      statusRow(l),
      ...l.notes.map((note) => ({ text: `${glyph("bullet")} ${note}`, fg: tokens.muted })),
    ];
  };

  const spec = (): LevelSpec => ({
    nav: {
      count: () => items().length,
      index: sel,
      setIndex: setSel,
      activate: {
        label: "install",
        run: () => {
          const l = selected();
          if (l && !l.installed && l.installable) deps.install(l);
        },
      },
    },
    verbs: [
      {
        key: "a",
        label: "add marketplace",
        run: () =>
          editor.start("marketplace git URL", "", (url) => {
            if (url.trim().length > 0) deps.addSource(url.trim());
          }),
      },
      verb("refresh", () => deps.refresh()),
    ],
  });

  bindLevelKeys({
    host,
    /* Without this the level's own verb keys stay bound while the field editor
       is open, so every 'a' typed into a URL was eaten by [a] add marketplace. */
    editor,
    register: (enabled) => registerLevel(keymap, { ...spec(), enabled }),
  });

  return (
    <ViewFrame host={host} title="Marketplace" unscoped>
      <Show when={deps.loading() && items().length > 0}>
        <LoadingHint text="fetching marketplaces" />
      </Show>
      <For each={broken()}>{(s) => <ErrorBanner text={`${s.url}: ${s.error}`} />}</For>
      <Show when={summary() !== undefined}>
        <box flexDirection="column" flexShrink={0} paddingBottom={1}>
          <text
            fg={installable() === 0 ? tokens.warn : tokens.muted}
            wrapMode="word"
            selectable={false}
          >
            {summary()}
          </text>
        </box>
      </Show>
      <SelectableList<MarketplaceListing>
        each={items}
        sel={sel}
        idPrefix="market-"
        loading={deps.loading}
        empty={() => ({
          text: "No marketplace configured, so there is nothing to browse.",
          hint:
            "A marketplace is a git repository listing plugins you can install. " +
            "Add one by its git URL, or install a plugin directly from Plugins.",
        })}
        row={(l, i) => (
          <SelectableRow selected={sel() === i()}>
            <span style={{ fg: rowFg(l) }}>{rowGlyph(l)} </span>
            <span style={{ fg: tokens.fg }}>{l.name}</span>
            <span style={{ fg: tokens.muted }}>
              {`  ${l.displayName !== undefined && l.displayName !== l.name ? l.displayName : (l.category ?? l.marketplace)}`}
            </span>
          </SelectableRow>
        )}
        trailing={
          <Show when={items().length > 0}>
            <box flexDirection="column" flexShrink={0} paddingTop={1}>
              <DetailLines rows={detailRows()} />
            </box>
          </Show>
        }
      />
      <Show when={editor.editing()}>{editor.EditInput()}</Show>
      {editor.PickerInput()}
    </ViewFrame>
  );
}
