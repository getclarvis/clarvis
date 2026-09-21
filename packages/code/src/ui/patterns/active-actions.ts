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
  /**
   * Shorter wording for the same action, used only when the full label does not fit.
   *
   * @remarks Authored per action, never derived by cutting a label: `cancel /
   *   quit` and `keep` are different decisions, and shrinking one into the other
   *   would be a behavior claim the projection cannot make.
   */
  shortLabel?: string;
  /** Raw `display` parts per announced key, parallel to {@link ActiveAction.keys}. */
  sequences?: string[][];
  /** Distinct directional actions grouped only for footer presentation. */
  keyGroups?: string[][];
  surfaces: ActionSurface[];
  footerLabel: string;
  hintPriority: number;
  hintGroup: ActionHintGroup;
  essential: boolean;
}

/** Presentation tone of one footer span; the theme owns the colors. */
export type FooterSpanTone = "key" | "label" | "prefix" | "separator";

/** One styled run of a footer row. Key and label stay separate so a key outranks its description. */
export interface FooterSpan {
  text: string;
  tone: FooterSpanTone;
}

/**
 * The band's own chrome columns — one leading and one trailing cell of its row.
 *
 * @remarks Every admission budget subtracts these, so a caller owes the
 *   projection the width of the **band**, not of the text inside it. A caller
 *   that subtracted its container's padding first charged for it twice and
 *   landed a tier low; see {@link bandWidthFor} for the reverse conversion.
 */
const BAND_CHROME_COLUMNS = 2;

/**
 * The band width that admits `usableCells` of text.
 *
 * @param usableCells - cells a container can really give the band, after its
 *   own padding, borders and any sibling pinned beside it.
 * @returns the value {@link budgetFooterActions} and {@link footerRows} expect.
 * @remarks This is the only supported way for a nested surface to convert real
 *   geometry into a band width. Pass it computed geometry, not the terminal
 *   width: a picker's card is narrower than the screen, and its own footer must
 *   be admitted by the space the card has.
 */
export function bandWidthFor(usableCells: number): number {
  return Math.max(0, usableCells) + BAND_CHROME_COLUMNS;
}

/** Resolves which command the keymap would dispatch for one announced key sequence. */
export type SequenceOwner = (sequence: readonly string[]) => string | undefined;

type ProjectableActiveKey = Pick<
  ActiveKey<Renderable, KeyEvent>,
  "display" | "command" | "commandAttrs" | "bindings"
>;

/** A projected key, plus the raw parts an already-expanded caller carries with it. */
type ProjectedKey = ProjectableActiveKey & { sequence?: string[] };

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
      entry.bindings.map((binding): ProjectedKey => ({
        display: binding.sequence.map((part) => part.display).join(" "),
        sequence: binding.sequence.map((part) => part.display),
        command: entry.command.name,
        commandAttrs: binding.commandAttrs ?? entry.command,
      })),
    ),
    client,
  );
}

/** Projects and deduplicates the active keymap's named actions. */
export function projectActiveActions(
  keys: readonly ProjectedKey[],
  client?: ClientPlatform,
): ActiveAction[] {
  const actions = new Map<string, ActiveAction>();
  const projectedKeys: ProjectedKey[] = keys.flatMap((key) =>
    key.bindings?.length
      ? key.bindings.map((binding) => ({
          ...key,
          display: binding.sequence.map((part) => part.display).join(" "),
          sequence: binding.sequence.map((part) => part.display),
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
      if (!existing.keys.includes(label)) {
        existing.keys.push(label);
        if (key.sequence) existing.sequences?.push(key.sequence);
      }
      continue;
    }
    const title = sentenceCase(typeof attrs.uiTitle === "string" ? attrs.uiTitle : key.command);
    actions.set(key.command, {
      id: key.command,
      title,
      description: typeof attrs.uiDescription === "string" ? attrs.uiDescription : title,
      category: typeof attrs.uiCategory === "string" ? attrs.uiCategory : "Other",
      keys: [label],
      ...(key.sequence ? { sequences: [key.sequence] } : {}),
      ...(typeof attrs.footerShortLabel === "string" ? { shortLabel: attrs.footerShortLabel } : {}),
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

/** One complete footer unit as styled runs; key and label are never truncated independently. */
function actionSpans(action: ActiveAction): FooterSpan[] {
  const keys =
    action.keyGroups?.map((group) => group.join("/")).join(" / ") ?? action.keys.join("/");
  return [
    { text: `[${keys}]`, tone: "key" },
    { text: ` ${action.footerLabel.toLowerCase()}`, tone: "label" },
  ];
}

/** A complete footer unit; key and label are never truncated independently. */
export function actionSegment(action: ActiveAction): string {
  return actionSpans(action)
    .map((span) => span.text)
    .join("");
}

/** Two cells between whole segments, and the wider group separator between prefix groups. */
const SEGMENT_GAP = "  ";
const GROUP_GAP = "  │  ";

function joinSpans(groups: readonly FooterSpan[][], gap: string): FooterSpan[] {
  const spans: FooterSpan[] = [];
  groups.forEach((group, index) => {
    if (index > 0) spans.push({ text: gap, tone: "separator" });
    spans.push(...group);
  });
  return spans;
}

/** Actions whose every announced key is a Ctrl+X continuation, i.e. the shared-prefix group. */
function sharedLeaderActions(actions: readonly ActiveAction[]): ActiveAction[] {
  return actions.filter(
    (action) =>
      action.keys.length > 0 && action.keys.every((key) => /^Ctrl\+X [a-zA-Z↑↓]+$/.test(key)),
  );
}

/** The same action with its shared Ctrl+X prefix folded away, for the grouped rendering. */
function compactSharedLeader(action: ActiveAction): ActiveAction {
  const strip = (keys: string[]): string[] =>
    keys.map((key) => key.slice("Ctrl+X ".length).toUpperCase());
  return { ...action, keys: strip(action.keys), keyGroups: action.keyGroups?.map(strip) };
}

/** Formats a footer with one shared modifier prefix, as styled runs. */
export function footerSpans(actions: readonly ActiveAction[], shared = false): FooterSpan[] {
  const grouped = sharedLeaderActions(actions);
  if (grouped.length < (shared ? 1 : 2)) return joinSpans(actions.map(actionSpans), SEGMENT_GAP);
  const plain = actions.filter((action) => !grouped.includes(action)).map(actionSpans);
  const compact = grouped.map((action) => actionSpans(compactSharedLeader(action)));
  const spans: FooterSpan[] = [];
  if (plain.length > 0) {
    spans.push(...joinSpans(plain, SEGMENT_GAP), { text: GROUP_GAP, tone: "separator" });
  }
  spans.push({ text: "Ctrl+X:", tone: "prefix" }, { text: " ", tone: "separator" });
  spans.push(...joinSpans(compact, SEGMENT_GAP));
  return spans;
}

/**
 * Joins whole action segments with one separator run.
 *
 * @param actions - the actions to print, in reading order.
 * @param gap - the separator drawn between two segments.
 * @returns the styled runs for one row.
 */
export function actionListSpans(actions: readonly ActiveAction[], gap: string): FooterSpan[] {
  return joinSpans(actions.map(actionSpans), gap);
}

/** Formats a footer with one shared modifier prefix, without changing help or bindings. */
export function footerText(actions: readonly ActiveAction[], shared = false): string {
  return footerSpans(actions, shared)
    .map((span) => span.text)
    .join("");
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
              shortLabel: "blocks",
            }
          : action,
      );
  }
  return eligible;
}

/**
 * The transcript band's visual row goal.
 *
 * @remarks Two rows are a target for reading, not a cap: this band preserves
 *   every action it was given, so a third row is preferred over dropping one.
 */
const RESPONSIVE_ROW_GOAL = 2;

/**
 * Packs every available footer action into rows, repeating shared modifiers per row.
 *
 * @param actions - the projected active actions, any surface.
 * @param width - the **band** width, as {@link budgetFooterActions} documents it.
 * @param lead - text that occupies the first row before the first segment, measured
 *   against that row's budget only.
 * @returns one array of actions per row, in reading order.
 * @remarks Nothing is dropped here — this is the surface that keeps all of its
 *   discovery. When the full labels would spend more than
 *   {@link RESPONSIVE_ROW_GOAL} rows, the authored short variants are tried:
 *   compact wording first, extra height only if it still helps.
 */
export function footerRows(
  actions: readonly ActiveAction[],
  width: number,
  lead = "",
): ActiveAction[][] {
  const eligible = footerCandidates(actions).sort(byReadingOrder);
  const shared = new Set(sharedLeaderActions(eligible));
  const ordered = [
    ...eligible.filter((action) => !shared.has(action)),
    ...eligible.filter((action) => shared.has(action)),
  ];
  const full = packRows(ordered, width, "full", lead);
  if (full.length <= RESPONSIVE_ROW_GOAL) return full;
  const compact = packRows(ordered, width, "short", lead);
  return compact.length < full.length ? compact : full;
}

/** Wraps all available footer actions as plain rows, one string per row. */
export function footerLines(actions: readonly ActiveAction[], width: number): string[] {
  return footerRows(actions, width).map((row) => footerText(row, true));
}

/** Greedy row packing for one label variant; every segment stays whole. */
function packRows(
  ordered: readonly ActiveAction[],
  width: number,
  variant: LabelVariant,
  lead: string,
): ActiveAction[][] {
  const rows: ActiveAction[][] = [];
  const budget = (): number =>
    Math.max(1, width - BAND_CHROME_COLUMNS - (rows.length === 0 ? Bun.stringWidth(lead) : 0));
  /**
   * A lead that cannot share the first row with a segment takes that row alone.
   *
   * @remarks The pending indicator is a whole unit; squeezing it beside a
   *   continuation it does not fit next to clipped both, and dropping the lead
   *   hides which prefix is held. Its own row costs one line and keeps both
   *   readable — the band's row goal is a target, not a cap.
   */
  if (lead.length > 0 && ordered.length > 0) {
    const first = footerText([labelVariant(ordered[0]!, variant)], true);
    if (Bun.stringWidth(lead) + Bun.stringWidth(first) > Math.max(1, width - BAND_CHROME_COLUMNS))
      rows.push([]);
  }
  let row: ActiveAction[] = [];
  for (const action of ordered) {
    const candidate = labelVariant(action, variant);
    if (row.length > 0 && Bun.stringWidth(footerText([...row, candidate], true)) > budget()) {
      rows.push(row);
      row = [];
    }
    row.push(candidate);
  }
  if (row.length > 0) rows.push(row);
  return rows;
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

/** The label variant an admission may fall back to before dropping an action. */
type LabelVariant = "full" | "short";

/** The action as it should be measured and printed under one variant. */
function labelVariant(action: ActiveAction, variant: LabelVariant): ActiveAction {
  if (variant === "full" || action.shortLabel === undefined) return action;
  return { ...action, footerLabel: action.shortLabel };
}

/**
 * Fits one row into `budget` cells, shortening the least important label first.
 *
 * @returns the row as it should be printed, or `undefined` when even the
 *   shortest authored wording does not fit.
 * @remarks Shortening is tried in reverse importance order so the primary verb
 *   keeps its wording longest, and only actions that declare a
 *   {@link ActiveAction.shortLabel} can be shortened at all.
 */
function fitRow(
  selected: readonly ActiveAction[],
  budget: number,
  measure: (value: string) => number,
): ActiveAction[] | undefined {
  const shortestFirst = [...selected].sort(byImportance).reverse();
  const shortened = new Set<string>();
  const row = (): ActiveAction[] =>
    selected
      .map((action) => (shortened.has(action.id) ? labelVariant(action, "short") : action))
      .sort(byReadingOrder);
  while (measure(footerText(row())) > budget) {
    const next = shortestFirst.find(
      (action) => action.shortLabel !== undefined && !shortened.has(action.id),
    );
    if (next === undefined) return undefined;
    shortened.add(next.id);
  }
  return row();
}

/** Inputs a caller may inject into {@link budgetFooterActions}. */
export interface FooterBudget {
  /** Cell-width measurement; injectable for tests. */
  measure?: (value: string) => number;
  /**
   * Width that decides the editorial seat cap, defaulting to `width`.
   *
   * @remarks The two budgets are deliberately separate. `width` is the band the
   *   row must fit in, which inside a card is the card's own interior; the cap is
   *   an editorial ranking that belongs to the surface's scope, so a card narrower
   *   than its terminal keeps the seats that terminal could afford. Passing one
   *   width for both once cost a 48-column card its escape route: the tier fell
   *   from 10 to 4 the moment the card's interior reached `fits`.
   */
  capWidth?: number;
}

/**
 * Width-budgets complete action segments.
 *
 * @param actions - the projected active actions, any surface.
 * @param width - the **band** width: the cells the row may occupy as the band
 *   contract in `specs/hosts/code-keyboard.md` §3.6 states it — the terminal band
 *   for the shell footer, or the cells a container really offers plus its band
 *   chrome (see {@link bandWidthFor}). Not the content width: `fits` subtracts the
 *   footer's own two columns of chrome itself, so a caller that also subtracted
 *   its padding first charged for it twice and landed a tier low — which is why
 *   the Settings hub lost its primary action across 72-103 and Providers lost
 *   Add/Delete at full width. A caller with something else on the row (a status
 *   pinned to the right, a card's own footer text) subtracts only that.
 * @param budget - optional measurement and seat-cap overrides; see
 *   {@link FooterBudget}.
 * @returns the seated actions in reading order, already carrying the label
 *   variant that made them fit.
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
 *   A seat that does not fit at its full wording is first retried with the
 *   shortest wording that stays faithful to its action, and only then dropped:
 *   `open plan` → `plan` costs a word, while dropping the segment costs the
 *   discovery. See {@link fitRow}.
 *
 *   There is no lower width cut-off here. The band table's `< 24` floor is the
 *   floor screen's to own. Below any usable width `fits` seats nothing anyway.
 */
export function budgetFooterActions(
  actions: readonly ActiveAction[],
  width: number,
  budget: FooterBudget = {},
): ActiveAction[] {
  if (width <= 0) return [];
  const measure = budget.measure ?? ((value: string) => Bun.stringWidth(value));
  const eligible = footerCandidates(actions);
  const limit = tierLimit(budget.capWidth ?? width);
  const allowance = Math.max(0, width - BAND_CHROME_COLUMNS);

  const selected: ActiveAction[] = [];
  let seated: ActiveAction[] = [];
  for (const action of [...eligible].sort(byImportance)) {
    if (selected.length >= limit) break;
    const fitted = fitRow([...selected, action], allowance, measure);
    if (fitted === undefined) continue;
    selected.push(action);
    seated = fitted;
  }
  return seated;
}

/**
 * Keeps the announced keys the keymap really dispatches to their own action.
 *
 * @param actions - the projected active actions, any surface.
 * @param owner - resolves the winning command for one announced sequence.
 * @returns the actions with only their winning keys; an action whose every
 *   announced key belongs to another command is dropped.
 * @remarks Two commands can announce the same sequence. Exactly one of them
 *   receives the key, and printing both claims a key the other does not own —
 *   the Plan page advertised the shell's `[Ctrl+X P] open plan` beside its own
 *   `[Ctrl+X P] close`, where only the latter could fire, so a reader could not
 *   tell which effect the sequence had on that screen.
 *
 *   An action is dropped only when *none* of its announced keys survives: a
 *   custom binding that is still live keeps the action visible with that key.
 *   Two actions that merely look alike — different sequences, different scopes —
 *   both stay. A key the owner cannot resolve is kept: this narrows the band to
 *   what dispatches, it does not hide what it cannot know.
 */
export function retainWinningActions(
  actions: readonly ActiveAction[],
  owner: SequenceOwner,
): ActiveAction[] {
  const retained: ActiveAction[] = [];
  for (const action of actions) {
    const sequences = action.sequences;
    if (sequences === undefined || sequences.length === 0) {
      retained.push(action);
      continue;
    }
    const winners = sequences.map((sequence) => owner(sequence));
    const survivors = winners.flatMap((winner, index) =>
      winner === undefined || winner === action.id ? [index] : [],
    );
    if (survivors.length === 0) continue;
    if (survivors.length === sequences.length) {
      retained.push(action);
      continue;
    }
    retained.push({
      ...action,
      keys: survivors
        .map((index) => action.keys[index])
        .filter((key): key is string => key !== undefined),
      sequences: survivors.map((index) => [...sequences[index]!]),
    });
  }
  return retained;
}
