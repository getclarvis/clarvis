/**
 * A reusable {@link LevelHost} level for editing a `Record<string, unknown>` in
 * place: the shape every free-form configuration map in this UI has, and which
 * until now had no editor at all.
 *
 * @remarks Written against the *structure* of a field editor and a level stack
 * rather than against `views/config`, both because `src/ui/**` may not import
 * `views/` and because that is what makes it reusable: a provider's `headers`
 * and `body` are the first two consumers, an MCP server's `env`/`headers` are
 * the obvious next, and neither knows about the other.
 *
 * The editor drills into nested objects instead of demanding one JSON blob per
 * key, so OpenRouter's `body.provider.order` is three ordinary rows rather than
 * a hand-typed `{"provider":{"order":[...]}}`.
 */

import type { Accessor, JSX } from "solid-js";
import { batch, createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import { SelectableRow } from "../primitives/selectable-row.tsx";
import { clampListIndex } from "./list-navigation.ts";
import { verb, type LevelSpec } from "./level-keys.ts";

/** How a map's values are authored, displayed and parsed. */
export type MapValueKind = "text" | "json";

/** The tone vocabulary a host's notifier accepts; matches `views/hint.ts`'s `HintTone`. */
type NoticeTone = "info" | "success" | "warn" | "error";

/**
 * The slice of a field editor a {@link MapEditor} drives.
 *
 * @remarks Declared structurally so this module never imports `views/config`.
 * `FieldEditor` satisfies it by shape, which is also what lets a test drive the
 * editor with three recording stubs instead of a rendered modal.
 */
export interface MapFieldEditor {
  start(
    label: string,
    current: string,
    commit: (value: string) => void,
    opts?: { alwaysCommit?: boolean },
  ): void;
  startMultiline(label: string, current: string, commit: (value: string) => void): void;
  startPick(
    label: string,
    items: { label: string; value: string; detail?: string }[],
    commit: (value: string) => void,
    opts?: { onManual?: () => void },
  ): void;
}

/** The slice of a `ViewHost`'s level stack a {@link MapEditor} pushes onto. */
export interface MapLevelStack {
  depth: Accessor<number>;
  push: (title: string) => void;
}

/** One key the add-picker offers, with the value picking it stages. */
export interface MapSuggestion {
  key: string;
  /** One line of explanation, shown beside the key in the picker. */
  detail?: string;
  /**
   * Staged verbatim when picked. Omitted opens the value editor on an empty
   * value instead, which is what a key with no sensible template wants.
   */
  value?: unknown;
}

/** What a {@link MapEditor} edits: one map, how to read it, and how to write it back. */
export interface MapEditorSpec {
  /** The map's name, used as the level title and the value-editor label. */
  label: string;
  kind: MapValueKind;
  /** Reads the map as currently staged; reactive, so the rows follow an edit. */
  read: () => Record<string, unknown> | undefined;
  /**
   * Writes the whole map back. `undefined` means the map is now empty and its
   * key should be dropped from the enclosing object rather than left as `{}`.
   */
  write: (next: Record<string, unknown> | undefined) => void;
  /** Rejects a key with the reason to show the user; `undefined` accepts it. */
  rejectKey?: (key: string, path: string[]) => string | undefined;
  /** Rejects a value with the reason to show the user; `undefined` accepts it. */
  rejectValue?: (value: unknown, path: string[], key: string) => string | undefined;
  /** Keys offered by `[a]` at `path`; an empty list falls straight through to free entry. */
  suggest?: (path: string[]) => readonly MapSuggestion[];
  /** A line rendered under the rows, e.g. where the values end up on the wire. */
  footnote?: (path: string[]) => string | undefined;
}

/** One rendered entry of the map at the current path. */
export interface MapRow {
  key: string;
  value: unknown;
  /** Whether `[enter]` drills into this value as a sublevel rather than editing it. */
  drills: boolean;
  /** The value column's text. */
  display: string;
}

/**
 * Whether a value is a plain object a {@link MapEditor} can drill into.
 *
 * @param value - any staged value.
 * @returns `true` for a non-null, non-array object.
 * @remarks Arrays are deliberately *not* drillable. A drill level is keyed by
 *   name, and an array's members are keyed by position — editing `["a","b"]` as
 *   a two-row map would silently make the index part of the data.
 */
export function isMapNode(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the object at `path`, treating anything missing or non-object as empty.
 *
 * @param root - the whole map, or `undefined` when unset.
 * @param path - the keys drilled into, outermost first.
 * @returns the object at `path`; `{}` when the path does not resolve.
 */
export function readAt(
  root: Record<string, unknown> | undefined,
  path: readonly string[],
): Record<string, unknown> {
  let node: Record<string, unknown> = root ?? {};
  for (const key of path) {
    const next = node[key];
    if (!isMapNode(next)) return {};
    node = next;
  }
  return node;
}

/**
 * Rebuilds `root` with every empty object removed, at any depth.
 *
 * @param root - the whole map.
 * @returns a new root carrying only the entries that hold something.
 * @remarks Bottom-up, so a branch whose every leaf was removed collapses in one
 *   pass rather than leaving a chain of empty objects behind it. `{}` is not the
 *   same value as an absent key on the wire — a router reads
 *   `"provider": {}` as a routing block it must honour.
 */
export function pruneEmpty(root: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root)) {
    if (!isMapNode(value)) {
      out[key] = value;
      continue;
    }
    const inner = pruneEmpty(value);
    if (Object.keys(inner).length > 0) out[key] = inner;
  }
  return out;
}

/**
 * Rebuilds `root` with `mutate` applied to a shallow copy of the object at `path`.
 *
 * @param root - the whole map, or `undefined` when unset.
 * @param path - the keys drilled into, outermost first.
 * @param mutate - receives a copy of the node at `path` and returns its replacement.
 * @returns a new root; the input is never mutated.
 * @remarks Every level on the way down is copied, so a staged map handed to a
 *   Solid signal is a genuinely new object at every ancestor of the edit — a
 *   mutation in place would leave the signal's identity unchanged and the rows
 *   stale.
 */
export function updateAt(
  root: Record<string, unknown> | undefined,
  path: readonly string[],
  mutate: (node: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const base = { ...(root ?? {}) };
  if (path.length === 0) return mutate(base);
  const [head, ...rest] = path;
  const child = base[head!];
  base[head!] = updateAt(isMapNode(child) ? child : {}, rest, mutate);
  return base;
}

/**
 * Renders one value for the row's value column.
 *
 * @param value - the staged value.
 * @param kind - how the map's values are authored.
 * @returns the display text; an object is summarised by its key count rather
 *   than serialised, because the row is one line and drilling in is the way to
 *   see it.
 */
export function formatMapValue(value: unknown, kind: MapValueKind): string {
  if (kind === "text") return typeof value === "string" ? value : String(value);
  if (isMapNode(value)) {
    const n = Object.keys(value).length;
    return `{ ${n} ${n === 1 ? "key" : "keys"} }`;
  }
  return JSON.stringify(value) ?? "";
}

/**
 * Projects the object at the current path into rows.
 *
 * @param node - the object being shown.
 * @param kind - how the map's values are authored.
 * @returns one row per entry, in the object's own key order.
 */
export function mapRows(node: Record<string, unknown>, kind: MapValueKind): MapRow[] {
  return Object.entries(node).map(([key, value]) => ({
    key,
    value,
    drills: kind === "json" && isMapNode(value),
    display: formatMapValue(value, kind),
  }));
}

/** Any character that could start or structure a JSON value; bare text has none of them. */
const JSON_PUNCTUATION = /["'{}[\]:,\\]/;

/**
 * Reads one authored value: JSON where it parses, bare text where it plainly is not JSON.
 *
 * @param text - the trimmed input.
 * @returns the parsed value, or the reason it could not be read.
 * @remarks The fallback is deliberate and bounded. Most scalar body fields a
 *   provider documents are enumerated strings — `sort: throughput`,
 *   `data_collection: deny`, `effort: medium` — and demanding `"throughput"`
 *   for each one turns the commonest edit into a JSON quiz whose failure mode
 *   is a parse error naming the word the user just typed. So: JSON first, and
 *   the raw text only when it carries no JSON punctuation at all. A half-written
 *   `["a` or `{x: 1` still fails loudly, which is precisely where a silent
 *   reinterpretation would be a data bug rather than a convenience.
 */
export function parseMapValue(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    if (!JSON_PUNCTUATION.test(text)) return { ok: true, value: text };
    return { ok: false, error: `not valid JSON ${glyph("emDash")} ${(e as Error).message}` };
  }
}

/** Clips `s` to `max` characters with a trailing ellipsis glyph. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const ell = glyph("ellipsis");
  return max <= ell.length ? ell.slice(0, max) : s.slice(0, max - ell.length) + ell;
}

/** A live map-editing level: its state, its key spec and its body. */
export interface MapEditor {
  /** True while a map level is on the stack. */
  active: Accessor<boolean>;
  /** Opens `spec` as a new level below the caller's current one. */
  open: (spec: MapEditorSpec) => void;
  /** The level title, including the drilled-into path (e.g. `body.provider`). */
  title: Accessor<string>;
  /** The keys drilled into below the map's root. */
  path: Accessor<string[]>;
  /** The rows currently shown. */
  rows: Accessor<MapRow[]>;
  /** The cursor. */
  index: Accessor<number>;
  /** This level's navigation and verbs, for the host's `specFor`. */
  levelSpec: () => LevelSpec;
  /** This level's body, for the host's `levels` entry. */
  Body: () => JSX.Element;
}

/**
 * Creates a {@link MapEditor} bound to a field editor and a host's level stack.
 *
 * @param deps.editor - drives the text / multiline / pick modals.
 * @param deps.notify - shows a rejected key or unparsable value.
 * @param deps.level - the stack this editor pushes its levels onto.
 * @returns the editor handle; call {@link MapEditor.open} to show a map.
 * @remarks The editor has no `close`. Escape is the host shell's, and it only
 *   decrements the stack depth — so the editor *derives* its state from that
 *   depth instead: falling back below the depth it was opened at clears the
 *   spec, and falling back by one level pops one key off the drilled path. Any
 *   other arrangement would need an escape hook the level stack does not have,
 *   and would drift out of step the first time something else popped a level.
 */
export function createMapEditor(deps: {
  editor: MapFieldEditor;
  notify: (message: string, tone?: NoticeTone) => void;
  level: MapLevelStack;
}): MapEditor {
  const [spec, setSpec] = createSignal<MapEditorSpec | null>(null);
  const [path, setPath] = createSignal<string[]>([]);
  const [index, setIndex] = createSignal(0);
  let baseDepth = 0;

  const node = createMemo<Record<string, unknown>>(() => {
    const s = spec();
    return s ? readAt(s.read(), path()) : {};
  });
  const rows = createMemo<MapRow[]>(() => {
    const s = spec();
    return s ? mapRows(node(), s.kind) : [];
  });

  createEffect(() => {
    const depth = deps.level.depth();
    if (spec() === null) return;
    if (depth < baseDepth) {
      persistPruned(spec()!.read() ?? {});
      setSpec(null);
      setPath([]);
      setIndex(0);
      return;
    }
    const want = depth - baseDepth;
    if (path().length > want) {
      setPath((p) => p.slice(0, want));
      setIndex(0);
    }
  });

  /**
   * Every state change that also moves the stack is batched, and the depth is
   * moved inside the same batch.
   *
   * @remarks Not a tidiness measure. Outside a batch, Solid runs the
   * reconciling effect the moment `path` is written — while the depth is still
   * the old one — so the effect computes `want` one level short and truncates
   * the very path the caller is in the middle of extending. Drilling in then
   * appears to do nothing at all.
   */
  function open(next: MapEditorSpec): void {
    baseDepth = deps.level.depth() + 1;
    batch(() => {
      setSpec(next);
      setPath([]);
      setIndex(0);
      deps.level.push(next.label);
    });
  }

  const currentRow = (): MapRow | undefined => rows()[clampListIndex(index(), rows().length)];

  /** Persists a rebuilt root, dropping the whole map when nothing is left in it. */
  /**
   * Write the map back, unless it is already exactly this.
   *
   * @remarks The equality check is what stops a *visit* from reading as an
   *   edit. Closing the editor persists the pruned map unconditionally, so
   *   opening an empty one and pressing Escape wrote `undefined` over
   *   `undefined`, marked the config `Unsaved`, and later demanded a discard
   *   confirmation for bytes that were verified byte-identical. Map values are
   *   JSON by construction here, and `updateAt` preserves key order, so a
   *   serialized comparison is exact for this shape.
   */
  function persist(next: Record<string, unknown>): void {
    const s = spec();
    if (!s) return;
    const value = Object.keys(next).length === 0 ? undefined : next;
    const current = s.read();
    if (JSON.stringify(current ?? null) === JSON.stringify(value ?? null)) return;
    s.write(value);
  }

  /**
   * Persists `next` with every empty object in it removed, root included.
   *
   * @remarks A nested object that has lost its last entry is not the same thing
   *   as one the user is still filling in, and only the caller knows which it is
   *   looking at. So the sweep is deliberately *not* in {@link persist}: staging a
   *   suggestion whose template is `{}` — `reasoning`, `logit_bias`, `max_price`
   *   — writes the empty object precisely so the row exists to drill into, and
   *   pruning it there would make those three suggestions unusable. It runs on
   *   the two edges where an empty object can only be leftover: removing an entry,
   *   and closing the editor.
   *
   *   Without it `body.provider` emptied of its last key stays staged, is saved,
   *   and reaches the wire as `"provider": {}` — which a router reads as a
   *   routing block, not as its absence.
   */
  function persistPruned(next: Record<string, unknown>): void {
    persist(pruneEmpty(next));
  }

  function setEntry(key: string, value: unknown): void {
    const s = spec();
    if (!s) return;
    persist(
      updateAt(s.read(), path(), (n) => {
        n[key] = value;
        return n;
      }),
    );
  }

  /** The reason `key` cannot be used here, or `undefined` when it can. */
  function keyProblem(key: string): string | undefined {
    const s = spec();
    if (!s) return undefined;
    if (key in node()) return `${key} is already set`;
    return s.rejectKey?.(key, path());
  }

  function commitText(key: string, raw: string): void {
    const bad = spec()?.rejectValue?.(raw, path(), key);
    if (bad) {
      deps.notify(bad, "error");
      return;
    }
    setEntry(key, raw);
  }

  function commitJson(key: string, raw: string): void {
    const text = raw.trim();
    if (text === "") {
      deps.notify(`${key} needs a value ${glyph("emDash")} enter one or remove the key`, "error");
      return;
    }
    const parse = parseMapValue(text);
    if (!parse.ok) {
      deps.notify(`${key}: ${parse.error}`, "error");
      return;
    }
    const parsed = parse.value;
    const bad = spec()?.rejectValue?.(parsed, path(), key);
    if (bad) {
      deps.notify(bad, "error");
      return;
    }
    setEntry(key, parsed);
  }

  /**
   * Opens the right modal for one entry's value.
   *
   * @remarks A JSON object or array gets the textarea; every scalar gets the
   *   one-line input. Typing `false` into a six-line textarea to turn
   *   `allow_fallbacks` off is the kind of friction that stops a knob being used.
   */
  function editValue(key: string, current: unknown): void {
    const s = spec();
    if (!s) return;
    const label = [s.label, ...path(), key].join(".");
    if (s.kind === "text") {
      deps.editor.start(label, typeof current === "string" ? current : "", (v) =>
        commitText(key, v),
      );
      return;
    }
    const structured = isMapNode(current) || Array.isArray(current);
    if (structured) {
      deps.editor.startMultiline(`${label}  (JSON)`, JSON.stringify(current, null, 2), (v) =>
        commitJson(key, v),
      );
      return;
    }
    const asText = current === undefined ? "" : JSON.stringify(current);
    deps.editor.start(`${label}  (JSON or plain text)`, asText ?? "", (v) => commitJson(key, v));
  }

  function activate(): void {
    const row = currentRow();
    if (!row) return;
    if (row.drills) {
      batch(() => {
        setPath((p) => [...p, row.key]);
        setIndex(0);
        deps.level.push(row.key);
      });
      return;
    }
    editValue(row.key, row.value);
  }

  function stage(key: string, value: unknown): void {
    const bad = keyProblem(key);
    if (bad) {
      deps.notify(bad, "error");
      return;
    }
    if (value === undefined) {
      editValue(key, undefined);
      return;
    }
    setEntry(key, value);
    deps.notify(`${key} added ${glyph("emDash")} open it to edit`);
  }

  function promptForKey(): void {
    const s = spec();
    if (!s) return;
    deps.editor.start(`new ${[s.label, ...path()].join(".")} key`, "", (raw) => {
      const key = raw.trim();
      if (key) stage(key, undefined);
    });
  }

  /**
   * Offers the documented keys for this level, with free entry always reachable.
   *
   * @remarks The escape to a typed key is the editor's `onManual` row, not an
   *   ordinary item in the list. The distinction is load-bearing: a picker long
   *   enough to grow a filter box hides every row a term does not match, and a
   *   suggestion list is a discovery aid rather than the space of legal keys —
   *   so typing the name of an undocumented key is exactly the moment a user
   *   most needs the escape, and exactly when an ordinary row would be filtered
   *   away leaving "no matches" and no way forward.
   */
  function addEntry(): void {
    const s = spec();
    if (!s) return;
    const offered = (s.suggest?.(path()) ?? []).filter((sg) => !(sg.key in node()));
    if (offered.length === 0) {
      promptForKey();
      return;
    }
    deps.editor.startPick(
      `add to ${[s.label, ...path()].join(".")}`,
      offered.map((sg) => ({
        label: sg.key,
        value: sg.key,
        ...(sg.detail !== undefined ? { detail: sg.detail } : {}),
      })),
      (picked) => stage(picked, offered.find((sg) => sg.key === picked)?.value),
      { onManual: promptForKey },
    );
  }

  function renameEntry(): void {
    const s = spec();
    const row = currentRow();
    if (!s || !row) return;
    deps.editor.start(`rename ${row.key}`, row.key, (raw) => {
      const key = raw.trim();
      if (!key || key === row.key) return;
      const bad = keyProblem(key);
      if (bad) {
        deps.notify(bad, "error");
        return;
      }
      persist(
        updateAt(s.read(), path(), (n) => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(n)) out[k === row.key ? key : k] = v;
          return out;
        }),
      );
    });
  }

  function removeEntry(): void {
    const s = spec();
    const row = currentRow();
    if (!s || !row) return;
    const remaining = rows().length - 1;
    persistPruned(
      updateAt(s.read(), path(), (n) => {
        delete n[row.key];
        return n;
      }),
    );
    setIndex((i) => Math.max(0, Math.min(i, remaining - 1)));
    deps.notify(`removed ${row.key}`);
  }

  const title = (): string => {
    const s = spec();
    return s ? [s.label, ...path()].join(".") : "";
  };

  function levelSpec(): LevelSpec {
    return {
      nav: {
        count: () => rows().length,
        index,
        setIndex,
        activate: { label: "edit", run: activate },
      },
      verbs: [
        verb("add", addEntry),
        verb("rename", renameEntry, () => rows().length > 0),
        verb("delete", removeEntry, () => rows().length > 0),
      ],
    };
  }

  function Body(): JSX.Element {
    const s = spec();
    if (!s) return <></>;
    return (
      <box flexDirection="column">
        <Show when={rows().length === 0}>
          <text flexShrink={0} fg={tokens.muted}>
            {`  no ${title()} entries`}
          </text>
        </Show>
        <For each={rows()}>
          {(row, i) => (
            <SelectableRow selected={index() === i()}>
              <span style={{ fg: tokens.fg }}>{clip(row.key, 27).padEnd(28)}</span>
              <span style={{ fg: tokens.muted }}>{clip(row.display, 44)}</span>
              <Show when={row.drills}>
                <span style={{ fg: tokens.accent2 }}>{"  " + glyph("chevronRight")}</span>
              </Show>
            </SelectableRow>
          )}
        </For>
        <Show when={s.footnote?.(path())}>
          <text flexShrink={0} fg={tokens.muted}>
            {"  " + s.footnote!(path())}
          </text>
        </Show>
      </box>
    );
  }

  return {
    active: () => spec() !== null,
    open,
    title,
    path,
    rows,
    index,
    levelSpec,
    Body,
  };
}
