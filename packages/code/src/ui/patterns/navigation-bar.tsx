import type { Accessor, JSX } from "solid-js";
import { createMemo, Show, For } from "solid-js";
import { KeymapProvider, useKeymapSelector } from "@opentui/keymap/solid";
import { useTerminalDimensions } from "@opentui/solid";
import type { Interaction } from "../../keys/interaction.ts";
import type { KeyboardEnvironment } from "../../keys/keyboard-profile.ts";
import { effectiveClientPlatform } from "../../keys/keyboard-profile.ts";
import { compactSequence } from "../../keys/keyspec.ts";
import { liveSequenceOwners, sequenceKey } from "../../keys/sequence-owner.ts";
import { glyph } from "../../theme/glyphs.ts";
import { tokens } from "../../theme/tokens.ts";
import {
  actionListSpans,
  bandWidthFor,
  budgetFooterActions,
  footerRows,
  footerSpans,
  projectActiveActions,
  projectCommandActions,
  retainWinningActions,
  type ActiveAction,
  type FooterSpan,
  type FooterSpanTone,
} from "./active-actions.ts";

/** One separator run between the pending continuations. */
const SEPARATOR_GAP = (): string => ` ${glyph("separator")} `;

/** One painted band row: the styled runs and whether it presents a pending prefix. */
interface BandRow {
  spans: FooterSpan[];
}

/** The pending leader state: the sequence actually held, and the continuations it still offers. */
interface PendingBand {
  label: string;
  actions: ActiveAction[];
}

/** The theme color of one span tone; keys outrank descriptions, the prefix is active. */
function spanFg(tone: FooterSpanTone): string {
  if (tone === "key") return tokens.fg;
  if (tone === "prefix") return tokens.accent;
  return tokens.muted;
}

/**
 * Reactive action projection shared by footer and modal chrome.
 *
 * @remarks The projection is narrowed to the sequences the keymap really
 *   dispatches ({@link retainWinningActions} over the layer graph), so a
 *   surface cannot advertise a chord that a higher layer took from it.
 */
function useActiveActions(environment: Accessor<KeyboardEnvironment>): Accessor<ActiveAction[]> {
  const projected = useKeymapSelector((keymap) => {
    const entries = keymap.getCommandEntries({ visibility: "reachable" });
    let owners: ReadonlyMap<string, string> | undefined;
    const owner = (sequence: readonly string[]): string | undefined => {
      owners ??= liveSequenceOwners(keymap);
      return owners.get(sequenceKey(sequence));
    };
    return { entries, owner };
  });
  return createMemo(() =>
    retainWinningActions(
      projectCommandActions(projected().entries, effectiveClientPlatform(environment())),
      projected().owner,
    ),
  );
}

/**
 * The pending prefix and the actions reachable from it.
 *
 * @remarks The continuation set comes from `getActiveKeys` while the sequence is
 *   pending, which is the keymap's own answer to "what would each next key do
 *   here" — so a custom binding appears with its real key and a shadowed
 *   command does not appear at all. The indicator names the sequence the user
 *   actually holds rather than assuming Ctrl+X.
 */
function usePendingBand(environment: Accessor<KeyboardEnvironment>): Accessor<PendingBand | null> {
  const pending = useKeymapSelector((keymap) => {
    const parts = keymap.getPendingSequence();
    if (parts.length === 0) return null;
    return { parts, keys: keymap.getActiveKeys({ includeBindings: true, includeMetadata: true }) };
  });
  return createMemo(() => {
    const current = pending();
    if (current === null) return null;
    const label = compactSequence(current.parts).trim();
    if (label.length === 0) return null;
    return {
      label,
      actions: projectActiveActions(current.keys, effectiveClientPlatform(environment())),
    };
  });
}

/** The key a continuation adds after the pending sequence; the whole label when it adds none. */
function continuationKey(key: string, pendingLabel: string): string {
  const prefix = `${pendingLabel} `;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/** The pending indicator's runs: the sequence held, then the continuation chevron. */
function prefixSpans(label: string): FooterSpan[] {
  return [
    { text: `${label} active`, tone: "prefix" },
    { text: ` ${glyph("chevronRight")} `, tone: "separator" },
  ];
}

/** Painted rows for already-packed action rows; empty projections paint nothing. */
function band(rows: readonly ActiveAction[][], shared: boolean): BandRow[] {
  return rows
    .map((row) => footerSpans(row, shared))
    .filter((spans) => spans.length > 0)
    .map((spans) => ({ spans }));
}

/**
 * Responsive footer projection; key and label always enter or leave as one complete segment.
 *
 * @param props.width - the band width in cells (the shell passes its terminal
 *   width). See {@link bandWidthFor} for a container that knows the cells it can
 *   really offer after its own padding, border and pinned siblings.
 */
export function NavigationBar(props: {
  environment: Accessor<KeyboardEnvironment>;
  width: Accessor<number>;
  /**
   * Cells this surface can really give the band, after its own padding, border and
   * any sibling pinned beside it. Omit it where the band's row **is** the whole
   * terminal row minus its own chrome: the shell footer. A frame or card that
   * omits it is admitted by the terminal and can paint past its own edge.
   */
  usableWidth?: Accessor<number>;
  actionFilter?: (action: ActiveAction) => boolean;
  /** Project surface-local wording without rebuilding the owning key layer. */
  actionTransform?: (action: ActiveAction) => ActiveAction;
  active?: Accessor<boolean>;
  responsive?: boolean;
}): JSX.Element {
  /** Cells the row must fit in; the caller's own geometry wins when it knows it. */
  const bandWidth = (): number =>
    props.usableWidth ? bandWidthFor(props.usableWidth()) : props.width();
  const actions = useActiveActions(props.environment);
  const visible = createMemo(() => {
    const transformed = props.actionTransform
      ? actions().map((action) => props.actionTransform!(action))
      : actions();
    return props.actionFilter ? transformed.filter(props.actionFilter) : transformed;
  });
  const pending = usePendingBand(props.environment);
  const pendingRows = createMemo<BandRow[]>(() => {
    const band = pending();
    if (band === null) return [];
    const continuations = actions()
      .filter((action) => props.actionFilter?.(action) ?? true)
      .map((action) => {
        const keyed = {
          ...action,
          keys: action.keys.map((key) => continuationKey(key, band.label)),
        };
        return props.actionTransform ? props.actionTransform(keyed) : keyed;
      });
    if (continuations.length === 0) return [];
    const lead = prefixSpans(band.label)
      .map((span) => span.text)
      .join("");
    return footerRows(continuations, bandWidth(), lead).map((row, index) => ({
      spans: [
        ...(index === 0 ? prefixSpans(band.label) : []),
        ...actionListSpans(row, SEPARATOR_GAP()),
      ],
    }));
  });
  const rows = createMemo<BandRow[]>(() => {
    const pendingBand = pendingRows();
    if (pendingBand.length > 0) return pendingBand;
    const candidates = visible();
    if (props.responsive) return band(footerRows(candidates, bandWidth()), true);
    const seated = budgetFooterActions(
      candidates,
      bandWidth(),
      // A nested band fits inside its own container but keeps the seat cap its
      // terminal can afford; see `FooterBudget`. The shell passes no usable width,
      // so both budgets are its band width as before.
      props.usableWidth ? { capWidth: props.width() } : {},
    );
    const seatedIds = new Set(seated.map((action) => action.id));
    /**
     * A decision the one-row band would hide rather than shorten.
     *
     * @remarks A confirmation's verbs are `essential`: `[y] delete` and
     *   `[n] keep` are the two paths of one question, and a row that can only
     *   fit the destructive one asks a question without offering its refusal.
     *   Wrapping costs a row; hiding a refusal costs the decision.
     */
    const hidesDecision = candidates.some(
      (action) =>
        action.surfaces.includes("footer") && action.essential && !seatedIds.has(action.id),
    );
    return hidesDecision ? band(footerRows(candidates, bandWidth()), true) : band([seated], false);
  });
  return (
    <Show when={(props.active?.() ?? true) && rows().length > 0}>
      <box flexDirection="column" flexShrink={0} width={props.responsive ? "100%" : undefined}>
        <For each={rows()}>
          {(row) => (
            <text fg={tokens.muted} wrapMode="char">
              <For each={row.spans}>
                {(span) => <span style={{ fg: spanFg(span.tone) }}>{span.text}</span>}
              </For>
            </text>
          )}
        </For>
      </box>
    </Show>
  );
}

/** The keyboard environment used when a host mounts the band outside the shell. */
const FALLBACK_ENVIRONMENT: KeyboardEnvironment = {
  transport: "local",
  runtimePlatform: "unknown",
  terminal: { name: "unknown" },
  protocol: "legacy",
  multiplexer: "unknown",
  modifiers: {
    ctrl: "unknown",
    shift: "unknown",
    meta: "unknown",
    super: "unknown",
    hyper: "unknown",
  },
  baseLayout: "unknown",
  profile: "portable",
};

function NavigationBarForInteraction(props: {
  interaction: Interaction;
  actionFilter?: (action: ActiveAction) => boolean;
  actionTransform?: (action: ActiveAction) => ActiveAction;
  usableWidth?: Accessor<number>;
  responsive?: boolean;
}): JSX.Element {
  const dimensions = useTerminalDimensions();
  return (
    <NavigationBar
      environment={props.interaction.keyboardEnvironment ?? (() => FALLBACK_ENVIRONMENT)}
      width={() => dimensions().width}
      usableWidth={props.usableWidth}
      responsive={props.responsive}
      actionFilter={props.actionFilter}
      actionTransform={props.actionTransform}
    />
  );
}

/** Self-contained navigation projection for frames also mounted in focused renderer tests. */
export function InteractionNavigationBar(props: {
  interaction: Interaction;
  actionFilter?: (action: ActiveAction) => boolean;
  actionTransform?: (action: ActiveAction) => ActiveAction;
  /**
   * Cells this surface can really give the band, after its own padding, border
   * and any sibling pinned beside it.
   *
   * @remarks Omit it only where the band's row **is** the whole terminal row minus
   *   its own two chrome cells — the shell footer. A card or a frame with a
   *   status column must pass its real geometry, or the band is admitted by
   *   space it does not have and the row is clipped.
   */
  usableWidth?: Accessor<number>;
  responsive?: boolean;
}): JSX.Element {
  if (
    typeof (props.interaction.keymap as Partial<Interaction["keymap"]>).getCommandEntries !==
      "function" ||
    typeof (props.interaction.keymap as Partial<Interaction["keymap"]>).getPendingSequence !==
      "function" ||
    typeof (props.interaction.keymap as Partial<Interaction["keymap"]>).on !== "function"
  )
    return null as never;
  return (
    <KeymapProvider keymap={props.interaction.keymap}>
      <NavigationBarForInteraction
        interaction={props.interaction}
        actionFilter={props.actionFilter}
        actionTransform={props.actionTransform}
        usableWidth={props.usableWidth}
        responsive={props.responsive}
      />
    </KeymapProvider>
  );
}
