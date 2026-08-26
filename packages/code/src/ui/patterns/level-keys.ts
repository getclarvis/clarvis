/**
 * View-side key helpers: level registration + footer hints.
 * Pure label formatters and LAYER live in keys/keyspec.ts.
 */
import type { KeyEvent, Renderable, ScrollBoxRenderable } from "@opentui/core";
import type { Binding, Keymap } from "@opentui/keymap";
import {
  LAYER,
  compactKey,
  compactSequence,
  commandKeyLabel,
  PROMPT_EDITING_KEYS,
  promptKeyLabel,
} from "../../keys/keyspec.ts";
import { registerListNav, registerScrollKeys } from "./list-navigation.ts";
import { uiCommand } from "../../keys/actions.ts";
import type { ActionHintGroup } from "../../keys/actions.ts";
import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";

export { LAYER, compactKey, compactSequence, commandKeyLabel, PROMPT_EDITING_KEYS, promptKeyLabel };

type OpenTuiKeymap = Keymap<Renderable, KeyEvent>;
type OpenTuiBinding = Binding<Renderable, KeyEvent>;

/** A single keyed action offered by a level, shown in its footer hint when `when` is absent or true. */
export interface VerbSpec {
  /** Stable semantic command id. */
  id?: string;
  key: string;
  label: string;
  run: () => void;
  when?: () => boolean;
  category?: string;
  hintGroup?: ActionHintGroup;
  hintPriority?: number;
  essential?: boolean;
}

/** The panel-wide verb names with fixed key/label pairs in {@link PANEL_VERBS}. */
export type PanelVerbName = "add" | "delete" | "rename" | "clear" | "refresh";

/** The canonical key binding and footer label for each {@link PanelVerbName}. */
export const PANEL_VERBS: Record<PanelVerbName, { key: string; label: string }> = {
  add: { key: "a", label: "add" },
  delete: { key: "d", label: "delete" },
  rename: { key: "r", label: "rename" },
  clear: { key: "x", label: "clear" },
  refresh: { key: "ctrl+r", label: "refresh" },
};

/**
 * Builds a {@link VerbSpec} from a {@link PanelVerbName}'s canonical key/label, plus its handler.
 *
 * @param name - Selects the key and label from {@link PANEL_VERBS}.
 * @param run - Invoked when the verb's key is pressed and `when` (if given) is true.
 * @param when - Optional guard; the verb is hidden from the footer and disabled when it returns false.
 * @returns The assembled {@link VerbSpec}.
 */
export function verb(name: PanelVerbName, run: () => void, when?: () => boolean): VerbSpec {
  const spec: VerbSpec = { id: `ui.level.${name}`, ...PANEL_VERBS[name], run };
  if (when) spec.when = when;
  return spec;
}

interface NavSpec {
  count: () => number;
  index: () => number;
  setIndex: (index: number) => void;
  activate?: { label: string; run: () => void; when?: () => boolean };
  lettersNav?: boolean;
  showArrows?: boolean;
  page?: number;
}

/** The key behaviour for one level: navigation, verbs, escape handling and guarded keys. */
export interface LevelSpec {
  /** Optional keymap context clause that suspends every layer owned by this level. */
  when?: string;
  /** Reactive surface gate that keeps the level registered but unreachable while inactive. */
  enabled?: () => boolean;
  nav?: NavSpec;
  /**
   * A pure-scroll level: when set and `nav` is absent, up/down/j/k/pageup/
   * pagedown scroll this box instead of moving a selection. Used where the body
   * is read-only prose (no row to select) but taller than the viewport — the
   * plan overlay's document view. `nav` wins when both are present.
   */
  scroll?: () => ScrollBoxRenderable | undefined;
  verbs?: VerbSpec[];
  escape?: { label: string; run?: () => void };
  guards?: string[];
}

/**
 * Installs a level's full key layer — navigation or scroll, verbs, guarded keys and escape — onto
 * `keymap`, at `priority`.
 *
 * @param keymap - The OpenTUI keymap to register layers on.
 * @param spec - The level's key behaviour; see {@link LevelSpec}.
 * @param priority - The layer priority for nav/verb bindings; defaults to `LAYER.LIST`.
 * @returns A function that unregisters every layer this call registered.
 * @remarks An `escape` handler is registered at `LAYER.OVERLAY + 1` (or above `priority` if higher),
 * so escape survives being layered under a lower-priority nav/verb registration.
 */
export function registerLevel(
  keymap: OpenTuiKeymap,
  spec: LevelSpec,
  priority: number = LAYER.LIST,
): () => void {
  const offs: (() => void)[] = [];
  const enabled = spec.enabled ? reactiveMatcherFromSignal(spec.enabled) : undefined;
  const noop = (): void => {};
  const commandId = (verbSpec: VerbSpec): string =>
    verbSpec.id ?? `ui.level.${verbSpec.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const verbs = spec.verbs ?? [];
  const bindings: OpenTuiBinding[] = verbs.map((v) => ({
    key: v.key,
    cmd: commandId(v),
  }));
  const verbCommands = verbs.map((v) =>
    uiCommand({
      id: commandId(v),
      title: v.label,
      description: `${v.label} in the current view`,
      category: v.category ?? "mutation",
      surfaces: ["footer"],
      footerLabel: v.label,
      hintPriority: v.hintPriority ?? 60,
      hintGroup: v.hintGroup ?? "mutation",
      ...(v.essential === undefined ? {} : { essential: v.essential }),
      ...(v.when ? { enabled: v.when } : {}),
      run: v.run,
    }),
  );
  // A gated verb's `when` is compiled into the command's `enabled` predicate, so
  // while it is false the *binding* is inactive — and an inactive binding lets its
  // key fall through to whatever lower layer or focused input claims it. The
  // predecessor of this code guarded inside `run`, which kept the key bound and
  // inert, and that swallow is load-bearing: Doctor's `q` on a hard-required gate
  // must do nothing, not reach the prompt underneath. A same-key function binding
  // after the command binding restores it — the command binding still wins while
  // it is enabled, and this absorbs the key when it is not. Exactly what
  // `spec.guards` does, derived instead of hand-listed.
  for (const v of verbs) if (v.when) bindings.push({ key: v.key, cmd: noop });
  for (const key of spec.guards ?? []) bindings.push({ key, cmd: noop });
  if (spec.nav) {
    const nav = spec.nav;
    offs.push(
      registerListNav(keymap, {
        count: nav.count,
        index: nav.index,
        setIndex: nav.setIndex,
        activate: nav.activate,
        letters: nav.lettersNav ?? true,
        page: nav.page,
        priority,
        when: spec.when,
        enabled,
        extra: bindings,
        extraCommands: verbCommands,
      }),
    );
  } else if (spec.scroll) {
    offs.push(
      registerScrollKeys(
        keymap,
        spec.scroll,
        priority,
        bindings.flatMap((binding) => (typeof binding.key === "string" ? [binding.key] : [])),
        spec.when,
        enabled,
      ),
    );
  } else if (bindings.length > 0) {
    offs.push(
      keymap.registerLayer({
        ...(spec.when === undefined ? {} : { when: spec.when }),
        ...(enabled === undefined ? {} : { enabled }),
        priority,
        commands: verbCommands,
        bindings,
      }),
    );
  }
  if (spec.scroll && bindings.length > 0) {
    offs.push(
      keymap.registerLayer({
        ...(spec.when === undefined ? {} : { when: spec.when }),
        ...(enabled === undefined ? {} : { enabled }),
        priority,
        commands: verbCommands,
        bindings,
      }),
    );
  }
  if (spec.escape?.run) {
    const run = spec.escape.run;
    offs.push(
      keymap.registerLayer({
        ...(spec.when === undefined ? {} : { when: spec.when }),
        ...(enabled === undefined ? {} : { enabled }),
        priority: priority >= LAYER.OVERLAY ? priority : LAYER.OVERLAY + 1,
        commands: [
          uiCommand({
            id: "ui.level.escape",
            title: spec.escape.label,
            description: `${spec.escape.label} the current level`,
            category: "escape",
            surfaces: ["footer"],
            footerLabel: spec.escape.label,
            hintPriority: 100,
            hintGroup: "escape",
            essential: true,
            run,
          }),
        ],
        bindings: [{ key: "escape", cmd: "ui.level.escape" }],
      }),
    );
  }
  return () => {
    for (const off of offs) off();
  };
}
