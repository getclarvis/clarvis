import type { Commands, CommandEntryView } from "../../keys/commands.ts";
import { GROUP_LABEL, GROUP_ORDER, isTopLevelCommand } from "../../keys/command-groups.ts";
import { glyph } from "../../theme/glyphs.ts";
import { slashTokenMatches, type CompleteItem, type CompleteProvider } from "./autocomplete.ts";
import type { ItemMatch } from "../../core/fuzzy.ts";

type CommandItem = CompleteItem & { match?: ItemMatch; exact?: boolean };

interface BrowseCandidate {
  item: CommandItem;
  canAct?: () => boolean;
}

/** Dependencies for the slash-command completion provider owned by the composer. */
export interface CommandCompletionDeps {
  commands: Commands;
}

/**
 * Builds the slash-command provider with a revision-scoped browse projection.
 *
 * @remarks A bare slash is the hottest command path. The command catalog, key hints and sorted row
 *   objects are reused until command registration or keyboard configuration changes. Dynamic
 *   `canAct` predicates are still evaluated on every query, and the returned array changes only
 *   when their boolean result changes. Filtered terms keep fresh fuzzy-match positions.
 */
export function createCommandCompletionProvider(deps: CommandCompletionDeps): CompleteProvider {
  let source: CommandEntryView[] | undefined;
  let browseCandidates: BrowseCandidate[] = [];
  let browseEnabled: boolean[] = [];
  let browseItems: CommandItem[] = [];

  const rebuildBrowse = (entries: CommandEntryView[]): void => {
    const rank = (group?: string): number =>
      GROUP_ORDER.findIndex((key) => GROUP_LABEL[key] === group);
    browseCandidates = entries
      .filter((entry) => entry.slashes.length > 0 && isTopLevelCommand(entry))
      .flatMap((entry) =>
        entry.slashes.map((slash) => ({
          item: commandItem(entry, slash, "", true),
          ...(entry.canAct === undefined ? {} : { canAct: entry.canAct }),
        })),
      );
    browseCandidates.sort(
      (left, right) =>
        rank(left.item.group) - rank(right.item.group) ||
        left.item.label.localeCompare(right.item.label),
    );
    browseEnabled = [];
    browseItems = [];
  };

  const browse = (entries: CommandEntryView[]): CommandItem[] => {
    if (source !== entries) {
      source = entries;
      rebuildBrowse(entries);
    }
    let changed = browseEnabled.length !== browseCandidates.length;
    for (let index = 0; index < browseCandidates.length; index += 1) {
      const enabled = browseCandidates[index]!.canAct?.() ?? true;
      if (browseEnabled[index] !== enabled) changed = true;
      browseEnabled[index] = enabled;
    }
    if (changed)
      browseItems = browseCandidates
        .filter((_, index) => browseEnabled[index])
        .map((candidate) => candidate.item);
    return browseItems;
  };

  return {
    id: "command",
    trigger: "/",
    label: "commands",
    query: (term) => {
      const normalized = term.trim();
      const entries = deps.commands.entries();
      if (normalized.length === 0) return browse(entries);

      const exactToken = "/" + normalized.toLowerCase();
      const isExact = (slash: string | undefined): boolean => slash?.toLowerCase() === exactToken;
      const nestedItems: CommandItem[] = entries.flatMap((entry) =>
        entry.slashes.flatMap((slash) =>
          entry.subcommands.flatMap((subcommand) => {
            const label = `${slash}/${subcommand.name}`;
            if (!label.slice(1).toLowerCase().includes(normalized.toLowerCase())) return [];
            return [
              {
                label,
                insert: "",
                detail: subcommand.desc ?? `Open ${subcommand.name}`,
                value: `route:${entry.name}:${subcommand.name}`,
                exact: label.toLowerCase() === exactToken,
              },
            ];
          }),
        ),
      );
      const items = deps.commands
        .entries(term)
        .filter(
          (entry) =>
            entry.slashes.length > 0 &&
            (entry.canAct?.() ?? true) &&
            slashTokenMatches(entry.slashes, term) &&
            (isTopLevelCommand(entry) || entry.slashes.some((slash) => isExact(slash))),
        )
        .flatMap((entry) =>
          entry.slashes.map((slash) => commandItem(entry, slash, exactToken, false)),
        );
      items.push(...nestedItems);
      const tier = (item: CommandItem): number =>
        item.exact ? 0 : item.match?.field === "label" ? 1 : 2;
      return items
        .map((item, index) => ({ item, index }))
        .sort((left, right) => tier(left.item) - tier(right.item) || left.index - right.index)
        .map(({ item }) => item);
    },
    onAccept: (item) => {
      if (item.value.startsWith("route:")) {
        const [, command, child] = item.value.split(":");
        if (command && child) deps.commands.route(command, child);
        return;
      }
      if (!item.insert) deps.commands.runCommand(item.value);
    },
  };
}

function commandItem(
  entry: CommandEntryView,
  slash: string,
  exactToken: string,
  browsing: boolean,
): CommandItem {
  const match = entry.match;
  const onLabel = match?.field === "slash" ? match.text === slash : match?.field === "title";
  const showMatchText = match !== undefined && !onLabel && match.field !== "name";
  const detailBase = showMatchText ? match.text : (entry.desc ?? entry.title);
  const item: CommandItem = {
    label: slash,
    insert: entry.subcommands.length > 0 ? slash + "/" : entry.args.length > 0 ? slash + " " : "",
    detail: detailBase + (entry.keyHint ? `  ${glyph("separator")}  ${entry.keyHint}` : ""),
    value: entry.name,
    group: browsing ? GROUP_LABEL[entry.group] : undefined,
  };
  if (exactToken !== "" && slash.toLowerCase() === exactToken) item.exact = true;
  if (match && onLabel) item.match = { field: "label", positions: match.positions };
  else if (match) item.match = { field: "detail", positions: match.positions };
  return item;
}
