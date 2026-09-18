import type { ActiveKey, CommandEntry } from "@opentui/keymap";
import type { KeyEvent, Renderable } from "@opentui/core";
import { compactKey } from "../../keys/keyspec.ts";
import type { ActionHintGroup, ActionSurface } from "../../keys/actions.ts";
import type { ClientPlatform } from "../../keys/keyboard-profile.ts";

/** One named action as seen from the current focus and pending key sequence. */
export interface ActiveAction {
  id: string;
  title: string;
  description: string;
  category: string;
  keys: string[];
  /** Distinct directional actions grouped only for footer presentation. */
  keyGroups?: string[][];
  surfaces: ActionSurface[];
  footerLabel: string;
  hintPriority: number;
  hintGroup: ActionHintGroup;
  essential: boolean;
}

type ProjectableActiveKey = Pick<
  ActiveKey<Renderable, KeyEvent>,
  "display" | "command" | "commandAttrs" | "bindings"
>;

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function hintGroup(value: unknown): ActionHintGroup {
  return value === "primary" || value === "navigation" || value === "mutation" || value === "escape"
    ? value
    : "navigation";
}

function sentenceCase(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

/** Projects complete reachable sequences, including actions behind a pending leader key. */
export function projectCommandActions(
  entries: readonly CommandEntry<Renderable, KeyEvent>[],
  client?: ClientPlatform,
): ActiveAction[] {
  return projectActiveActions(
    entries.flatMap((entry) =>
      entry.bindings.map((binding) => ({
        display: binding.sequence.map((part) => part.display).join(" "),
        command: entry.command.name,
        commandAttrs: binding.commandAttrs ?? entry.command,
      })),
    ),
    client,
  );
}

/** Projects and deduplicates the active keymap's named actions. */
export function projectActiveActions(
  keys: readonly ProjectableActiveKey[],
  client?: ClientPlatform,
): ActiveAction[] {
  const actions = new Map<string, ActiveAction>();
  const projectedKeys = keys.flatMap((key) =>
    key.bindings?.length
      ? key.bindings.map((binding) => ({
          ...key,
          display: binding.sequence.map((part) => part.display).join(" "),
          command: binding.command,
          commandAttrs: binding.commandAttrs,
        }))
      : [key],
  );
  for (const key of projectedKeys) {
    if (typeof key.command !== "string") continue;
    const attrs = key.commandAttrs ?? {};
    const surfaces = strings(attrs.uiSurfaces) as ActionSurface[];
    if (surfaces.length === 0) continue;
    const label = compactKey(key.display, { clientPlatform: client });
    const existing = actions.get(key.command);
    if (existing) {
      if (!existing.keys.includes(label)) existing.keys.push(label);
      continue;
    }
    const title = sentenceCase(typeof attrs.uiTitle === "string" ? attrs.uiTitle : key.command);
    actions.set(key.command, {
      id: key.command,
      title,
      description: typeof attrs.uiDescription === "string" ? attrs.uiDescription : title,
      category: typeof attrs.uiCategory === "string" ? attrs.uiCategory : "Other",
      keys: [label],
      surfaces,
      footerLabel: typeof attrs.footerLabel === "string" ? attrs.footerLabel : title,
      hintPriority: typeof attrs.hintPriority === "number" ? attrs.hintPriority : 0,
      hintGroup: hintGroup(attrs.hintGroup),
      essential: attrs.essential === true,
    });
  }
  return [...actions.values()].sort(
    (a, b) => b.hintPriority - a.hintPriority || a.title.localeCompare(b.title),
  );
}

/** A complete footer unit; key and label are never truncated independently. */
export function actionSegment(action: ActiveAction): string {
  const keys =
    action.keyGroups?.map((group) => group.join("/")).join(" / ") ?? action.keys.join("/");
  return `[${keys}] ${action.footerLabel.toLowerCase()}`;
}

/** Formats a footer with one shared modifier prefix, without changing help or bindings. */
export function footerText(actions: readonly ActiveAction[], shared = false): string {
  const grouped = actions.filter(
    (action) =>
      action.keys.length > 0 && action.keys.every((key) => /^Ctrl\+X [a-zA-Z↑↓]+$/.test(key)),
  );
  if (grouped.length < (shared ? 1 : 2)) return actions.map(actionSegment).join("  ");
  const plain = actions.filter((action) => !grouped.includes(action)).map(actionSegment);
  const compact = grouped.map((action) =>
    actionSegment({
      ...action,
      keys: action.keys.map((key) => key.slice("Ctrl+X ".length).toUpperCase()),
      keyGroups: action.keyGroups?.map((group) =>
        group.map((key) => key.slice("Ctrl+X ".length).toUpperCase()),
      ),
    }),
  );
  return [plain.join("  "), `Ctrl+X: ${compact.join("  ")}`].filter(Boolean).join("  │  ");
}

function footerCandidates(actions: readonly ActiveAction[]): ActiveAction[] {
  let eligible = actions.filter((action) => action.surfaces.includes("footer"));
  const previous = eligible.find((action) => action.id === "transcript.focusPrev");
  const next = eligible.find((action) => action.id === "transcript.focusNext");
  if (previous && next) {
    eligible = eligible
      .filter((action) => action !== next)
      .map((action) =>
        action === previous
          ? {
              ...previous,
              keys: [...previous.keys, ...next.keys],
              keyGroups: [previous.keys, next.keys],
              footerLabel: "previous / next block",
            }
          : action,
      );
  }
  return eligible;
}

/** Wraps all available footer actions, repeating shared modifiers on each new row. */
export function footerLines(actions: readonly ActiveAction[], width: number): string[] {
  const eligible = footerCandidates(actions).sort(byReadingOrder);
  const shared = (action: ActiveAction): boolean =>
    action.keys.length > 0 && action.keys.every((key) => /^Ctrl\+X [a-zA-Z↑↓]+$/.test(key));
  const ordered = [...eligible.filter((action) => !shared(action)), ...eligible.filter(shared)];
  const lines: string[] = [];
  let row: ActiveAction[] = [];
  for (const action of ordered) {
    if (
      row.length > 0 &&
      Bun.stringWidth(footerText([...row, action], true)) > Math.max(1, width - 2)
    ) {
      lines.push(footerText(row, true));
      row = [];
    }
    row.push(action);
  }
  if (row.length > 0) lines.push(footerText(row, true));
  return lines;
}

/**
 * How many footer segments a terminal of this width may seat.
 *
 * @remarks A deliberate cap on *count*, not a width check — `fits` is the width
 * check, and it is applied to every seat, so raising a tier can never overflow
 * the row. The cap exists so a wide terminal does not print a wall of hints.
 *
 * At and above 100 columns, `fits` alone decides which candidates remain. This
 * avoids dropping a panel's own verbs on a terminal that has room for them while
 * retaining the deliberate editorial cap on narrower rows.
 */
function tierLimit(width: number): number {
  if (width >= 100) return 10;
  if (width >= 72) return 4;
  if (width >= 48) return 3;
  return 2;
}

const FOOTER_GROUP_ORDER: Record<ActionHintGroup, number> = {
  primary: 0,
  navigation: 1,
  mutation: 2,
  escape: 3,
};

/** Reading order of the footer: which group a segment is printed in. */
function byReadingOrder(a: ActiveAction, b: ActiveAction): number {
  return (
    FOOTER_GROUP_ORDER[a.hintGroup] - FOOTER_GROUP_ORDER[b.hintGroup] ||
    b.hintPriority - a.hintPriority ||
    a.title.localeCompare(b.title)
  );
}

/**
 * Admission order of the footer: which segment earns a seat when they do not all fit.
 *
 * @remarks Essentials come first and compete among themselves on declared
 *   `hintPriority` alone — a confirmation's `cancel` sits in the `escape` group
 *   and must not lose its seat to a lower-priority `primary` essential.
 *   Everything else keeps the footer's own group
 *   precedence, which is a deliberate ranking as well as a print order: a level's
 *   `move` matters more than its mutation verbs even though mutation verbs
 *   default to the higher `hintPriority`.
 */
function byImportance(a: ActiveAction, b: ActiveAction): number {
  if (a.essential !== b.essential) return Number(b.essential) - Number(a.essential);
  if (a.essential) return b.hintPriority - a.hintPriority || a.title.localeCompare(b.title);
  return byReadingOrder(a, b);
}

/**
 * Width-budgets complete action segments.
 *
 * @param actions - the projected active actions, any surface.
 * @param width - the **terminal-band** width in cells, as the band table in
 *   `specs/hosts/code-bootstrap.md` §4.10 states it. Not the content width: `fits` subtracts
 *   the footer's own two columns of chrome itself, so a caller that also
 *   subtracted its padding first charged for it twice and landed a tier low —
 *   which is why the Settings hub lost its primary action across 72-103 and
 *   Providers lost Add/Delete at full width. A caller with something else on the
 *   row (a run strip) subtracts only that.
 * @param measure - cell-width measurement; injectable for tests.
 * @returns the seated actions in reading order.
 * @remarks Seats are awarded in **importance** order and printed in **reading**
 *   order, and every seat is width-checked. Both halves are load-bearing.
 *
 *   Awarding by importance is what keeps a pair of actions that belong together
 *   together. `ViewFrame` no longer prints a static `[y]/[n]` row, so a
 *   confirmation's two verbs reach the user only through this budget — and
 *   `confirm.cancel` sits in the `escape` group, last in reading order. Filling
 *   seats in reading order handed the last one to `confirm.accept` and dropped
 *   `[n] cancel`, leaving a destructive prompt whose only visible "cancel" was
 *   `run.cancel`, which cancels the *run*.
 *
 *   Width-checking every seat, essentials included, is what stops the row
 *   overflowing its container: the essentials used to be seated by count alone,
 *   before `fits` was ever consulted. A narrow terminal now drops the least
 *   important segment instead of painting past its edge.
 *
 *   There is no lower width cut-off here. The band table's `< 24` floor is the
 *   floor screen's to own. Below any usable width `fits` seats nothing anyway.
 */
export function budgetFooterActions(
  actions: readonly ActiveAction[],
  width: number,
  measure: (value: string) => number = (value) => Bun.stringWidth(value),
): ActiveAction[] {
  if (width <= 0) return [];
  const eligible = footerCandidates(actions);
  const limit = tierLimit(width);
  const fits = (next: readonly ActiveAction[]): boolean =>
    measure(footerText(next)) <= Math.max(0, width - 2);

  const selected: ActiveAction[] = [];
  for (const action of [...eligible].sort(byImportance)) {
    if (selected.length >= limit) break;
    const next = [...selected, action].sort(byReadingOrder);
    if (fits(next)) selected.push(action);
  }
  selected.sort(byReadingOrder);
  return selected;
}
