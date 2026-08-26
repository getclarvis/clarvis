import type { JSX } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  Index,
  onCleanup,
  Show,
  type Accessor,
} from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { tokens } from "../../theme/tokens.ts";
import { scrollbarOptions } from "../../theme/surfaces.ts";
import type { Interaction } from "../../keys/interaction.ts";
import type { CommandEntryView } from "../../keys/commands.ts";
import { commandKeyLabel, compactKey, compactSequence } from "../../keys/keyspec.ts";
import { registerScrollKeys } from "../../ui/patterns/list-navigation.ts";
import { projectActiveActions } from "../../ui/patterns/active-actions.ts";
import { effectiveClientPlatform } from "../../keys/keyboard-profile.ts";
import { PageFrame } from "../PageFrame.tsx";
import { padColumn } from "../truncate.ts";
import { glyph } from "../../theme/glyphs.ts";

/** The width the label column is padded to before the description begins. */
const LABEL_COLUMN = 22;

interface Section {
  title: string;
  rows: [string, string][];
  plain?: boolean;
}

function bracketKeys(display: string): string {
  return display
    .split(" / ")
    .map((alternative) => `[${compactKey(alternative)}]`)
    .join(" / ");
}

const EDITING_CATEGORIES = new Set(["Text Editing", "editing", "prompt"]);

/** Screen chrome belonging to whatever view this Help is mounted inside, not to the app. */
const CHROME_COMMAND = /^(ui\.|view\.|confirm\.|autocomplete\.|elicit\.|editor\.)/;

function commandText(command: { name: string; desc?: unknown; title?: unknown }): string {
  return typeof command.desc === "string"
    ? command.desc
    : typeof command.title === "string"
      ? command.title
      : command.name;
}

/**
 * Complete interaction reference composed from live commands plus conceptual input syntax.
 * Active actions, destinations and editing commands are projections, never copied key tables.
 */
export function Help(props: {
  interaction: Interaction;
  entries?: (term?: string) => CommandEntryView[];
  active?: Accessor<boolean>;
}): JSX.Element {
  let scrollEl: ScrollBoxRenderable | undefined;
  const [revision, setRevision] = createSignal(0);
  let offScroll: (() => void) | undefined;
  let offState: (() => void) | undefined;
  createEffect(() => {
    const active = props.active?.() ?? true;
    offState?.();
    offScroll?.();
    offState = undefined;
    offScroll = undefined;
    if (!active) return;
    offScroll = registerScrollKeys(props.interaction.keymap, () => scrollEl);
    const onState = (props.interaction.keymap as Partial<Interaction["keymap"]>).on as
      ((name: "state", listener: () => void) => () => void) | undefined;
    offState = onState
      ? onState.call(props.interaction.keymap, "state", () => setRevision((value) => value + 1))
      : undefined;
    setRevision((value) => value + 1);
  });
  onCleanup(() => {
    offState?.();
    offScroll?.();
  });

  const available = createMemo(() => {
    revision();
    const getActiveKeys = (props.interaction.keymap as Partial<Interaction["keymap"]>)
      .getActiveKeys;
    if (!getActiveKeys || !props.interaction.keyboardEnvironment) return [];
    return projectActiveActions(
      getActiveKeys.call(props.interaction.keymap, {
        includeBindings: true,
        includeMetadata: true,
      }),
      effectiveClientPlatform(props.interaction.keyboardEnvironment()),
    );
  });

  const editing = (): Section => {
    revision();
    const rows: [string, string][] = [];
    const getEntries = (props.interaction.keymap as Partial<Interaction["keymap"]>)
      .getCommandEntries;
    if (!getEntries) return { title: "Editing", rows };
    for (const entry of getEntries.call(props.interaction.keymap, { visibility: "registered" })) {
      if (!EDITING_CATEGORIES.has(String(entry.command.category))) continue;
      if (entry.bindings.length === 0) continue;
      const keys = commandKeyLabel(props.interaction.keymap, entry.command.name, {
        visibility: "registered",
      });
      if (!keys) continue;
      rows.push([keys, commandText(entry.command)]);
    }
    return { title: "Editing", rows };
  };

  /**
   * Keys that exist but are not active on this screen.
   *
   * @remarks Projected from `registered` visibility, not `active`. `/help` is
   *   itself a view overlay, so it pushes the `view` overlay context and every
   *   binding gated on `overlay==none` — expand/collapse blocks, the block
   *   cursor, transcript scrolling, the memory toggle, Run controls, sub-agent
   *   focus — is inactive for exactly as long as the reader is looking at it.
   *   "Available here" therefore cannot list them, and with the static key
   *   tables gone the one screen whose purpose is the key reference documented
   *   none of the app's global keys at all.
   */
  const elsewhere = createMemo<Section>(() => {
    revision();
    const rows: [string, string][] = [];
    const getEntries = (props.interaction.keymap as Partial<Interaction["keymap"]>)
      .getCommandEntries;
    if (!getEntries) return { title: "Available elsewhere", rows };
    const active = new Set(available().map((action) => action.id));
    const seen = new Set<string>();
    for (const entry of getEntries.call(props.interaction.keymap, { visibility: "registered" })) {
      const command = entry.command;
      if (entry.bindings.length === 0) continue;
      if (active.has(command.name) || seen.has(command.name)) continue;
      if (EDITING_CATEGORIES.has(String(command.category))) continue;
      if (CHROME_COMMAND.test(command.name)) continue;
      const keys = [...new Set(entry.bindings.map((b) => compactSequence(b.sequence)))].join(" / ");
      if (keys.length === 0) continue;
      seen.add(command.name);
      rows.push([keys, commandText(command)]);
    }
    return { title: "Available elsewhere", rows };
  });

  const sections = createMemo<Section[]>(() => {
    revision();
    const current = available();
    const availableSection: Section = {
      title: "Available here",
      rows: current.map((action) => [action.keys.join(" / "), action.description]),
    };
    const destinations: Section = {
      title: "Go to",
      plain: true,
      rows: (props.entries?.() ?? [])
        .filter((entry) => entry.category === "view" || entry.parent !== undefined)
        .map((entry) => [
          entry.parent ? `${entry.parent} > ${entry.title}` : entry.title,
          entry.desc ?? entry.title,
        ]),
    };
    const syntax: Section = {
      title: "Input syntax",
      plain: true,
      rows: [
        ["/", "search commands and destinations"],
        ["@", "mention a workspace file; images attach"],
        ["!", "run a local shell command"],
        ["arguments", "follow a slash command after its name"],
      ],
    };
    const mouse: Section = {
      title: "Mouse",
      plain: true,
      rows: props.interaction.renderer?.useMouse
        ? [
            ["Wheel", "scroll the region under the pointer"],
            ["Drag", "select and copy text"],
            ["Click", "activate the row's primary semantic action"],
          ]
        : [],
    };
    const environment = props.interaction.keyboardEnvironment?.() ?? {
      profile: "portable",
      transport: "local",
      protocol: "legacy",
      multiplexer: "unknown",
    };
    const keyboard: Section = {
      title: "Keyboard environment",
      plain: true,
      rows: [
        ["Profile", environment.profile],
        ["Path", `${environment.transport} · ${environment.protocol} · ${environment.multiplexer}`],
        ["Diagnostics", "Settings > Keyboard, or Doctor > keyboard diagnostic"],
      ],
    };
    return [availableSection, elsewhere(), destinations, editing(), syntax, mouse, keyboard].filter(
      (section) => section.rows.length > 0,
    );
  });

  return (
    <PageFrame title="Help" interaction={props.interaction}>
      <scrollbox
        ref={(element: ScrollBoxRenderable) => (scrollEl = element)}
        flexGrow={1}
        verticalScrollbarOptions={scrollbarOptions()}
      >
        <Index each={sections()}>
          {(section) => (
            <box flexDirection="column" flexShrink={0} paddingTop={1}>
              <text fg={tokens.accent2}>{section().title}</text>
              <Index each={section().rows}>
                {(row) => {
                  const label = (): string => (section().plain ? row()[0] : bracketKeys(row()[0]));
                  /**
                   * A label wider than its column gets an explicit separator.
                   *
                   * @remarks {@link padColumn} falls back to a single trailing
                   * space when the text overruns, and one space is not a column
                   * boundary: `sessions > Export transcript Write the transcript
                   * to a file` reads as one run-on sentence, with nothing to say
                   * where the destination ends and its description begins. This
                   * happens at full width, so it is not a truncation artefact.
                   */
                  const overflows = (): boolean => label().length >= LABEL_COLUMN;
                  return (
                    <text>
                      <span style={{ fg: tokens.fg }}>{padColumn(label(), LABEL_COLUMN)}</span>
                      <Show when={overflows()}>
                        <span style={{ fg: tokens.muted }}>{`${glyph("separator")} `}</span>
                      </Show>
                      <span style={{ fg: tokens.muted }}>{row()[1]}</span>
                    </text>
                  );
                }}
              </Index>
            </box>
          )}
        </Index>
      </scrollbox>
    </PageFrame>
  );
}
