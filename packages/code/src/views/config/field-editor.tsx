import type { Accessor, JSX } from "solid-js";
import { createEffect, createSignal, onCleanup } from "solid-js";
import type { InputRenderable, TextareaRenderable } from "@opentui/core";
import {
  createTextareaBindings,
  registerManagedTextareaLayer,
} from "@opentui/keymap/addons/opentui";
import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import { tokens } from "../../theme/tokens.ts";
import { borderChars, glyph } from "../../theme/glyphs.ts";
import type { Interaction } from "../../keys/interaction.ts";
import { LAYER } from "../../ui/patterns/level-keys.ts";
import { CatalogPicker, type CatalogPickerSpec } from "./CatalogPicker.tsx";
import type { CatalogRow } from "./catalog-pick.ts";
import { uiCommand } from "../../keys/actions.ts";
import { SurfaceBoundary } from "../../ui/patterns/surface-lifecycle.tsx";

const secretMask = (): string => glyph("bullet");

/** One selectable option in a {@link FieldEditor.startPick} / {@link FieldEditor.startEnum} list. */
export interface PickItem {
  label: string;
  value: string;
  detail?: string;
}

/** The field editor's current in-progress edit, or absent when nothing is being edited. */
export type FieldEditState =
  | { mode: "text"; label: string; current: string }
  | { mode: "secret"; label: string }
  | {
      mode: "pick";
      label: string;
      items: PickItem[];
      initial: number;
      initialValue?: string;
      onManual?: () => void;
    }
  | { mode: "multiline"; label: string; current: string };

interface NumberFieldOpts {
  min?: number;
  max?: number;
  commit: (value: number | undefined) => void;
  notify: (message: string) => void;
}

/**
 * A single-slot, modal field editor shared by every config panel: only one
 * field can be mid-edit at a time, and starting a new edit implicitly
 * replaces whatever was in progress.
 */
export interface FieldEditor {
  /** The in-progress edit, if any; render {@link FieldEditor.EditInput} while non-null. */
  editing: Accessor<FieldEditState | null>;
  /**
   * Text field. By default re-confirming the unchanged value is a no-op (it
   * never dirties a config panel). Callers whose commit performs an *action*
   * rather than staging a dirty edit — e.g. re-running a search, clearing a
   * filter — pass `alwaysCommit` so an unchanged value still fires.
   */
  start(
    label: string,
    current: string,
    commit: (value: string) => void,
    opts?: { alwaysCommit?: boolean },
  ): void;
  /** Masked-input field (e.g. an API key); the raw value is never rendered. */
  startSecret(label: string, commit: (value: string) => void): void;
  /** Numeric field, rejecting non-finite input and values outside `opts.min`/`opts.max`. */
  startNumber(label: string, current: number | undefined, opts: NumberFieldOpts): void;
  /**
   * Opens a {@link CatalogPicker} over an arbitrary item list.
   *
   * @param opts.onManual - offers a trailing "manual entry" row that survives
   *   every filter term, for a list whose items are suggestions rather than the
   *   whole space of legal answers. Without it, typing a term that matches
   *   nothing leaves the user with "no matches" and no way forward.
   */
  startPick(
    label: string,
    items: PickItem[],
    commit: (value: string) => void,
    opts?: { onManual?: () => void },
  ): void;
  /** Opens a {@link CatalogPicker} over a fixed enum, pre-selecting `current`. */
  startEnum(
    label: string,
    options: readonly (string | PickItem)[],
    current: string | undefined,
    commit: (value: string) => void,
  ): void;
  /** Textarea field for multi-line content, applied with ctrl+s rather than return. */
  startMultiline(label: string, current: string, commit: (value: string) => void): void;
  /** Renders whatever edit mode {@link FieldEditor.editing} currently holds. */
  EditInput: () => JSX.Element;
  /** Lazily retained catalog surface for pick/enum edits; mount once beside the owning view. */
  PickerInput: () => JSX.Element;
}

/** Builds a {@link FieldEditor} bound to the given keymap/renderer. */
export function createFieldEditor(
  interaction: Interaction,
  active: Accessor<boolean> = () => true,
): FieldEditor {
  const keymap = interaction.keymap;
  const [editing, setEditing] = createSignal<FieldEditState | null>(null);
  let value = "";
  let pickCommit: ((value: string) => void) | null = null;
  let multiline: TextareaRenderable | undefined;
  let focusedInput: InputRenderable | TextareaRenderable | undefined;
  let activeOff: (() => void) | undefined;
  const enabled = reactiveMatcherFromSignal(active);
  const clearLayer = (): void => {
    activeOff?.();
    activeOff = undefined;
  };
  const setLayer = (register: () => () => void): void => {
    clearLayer();
    activeOff = register();
  };
  createEffect(() => {
    const shouldFocus = active() && editing() !== null && editing()?.mode !== "pick";
    const input = focusedInput;
    if (!input) return;
    queueMicrotask(() => {
      if (focusedInput !== input) return;
      if (shouldFocus) input.focus();
      else input.blur();
    });
  });
  onCleanup(() => {
    clearLayer();
    focusedInput?.blur();
  });

  const noop = (): void => {};
  const GUARDS = [
    { key: "ctrl+s", cmd: noop },
    { key: "ctrl+t", cmd: noop },
  ];

  function start(
    label: string,
    current: string,
    commit: (value: string) => void,
    opts?: { alwaysCommit?: boolean },
  ): void {
    value = current;
    const apply = (): void => {
      clearLayer();
      setEditing(null);
      if (opts?.alwaysCommit || value !== current) commit(value);
    };
    const cancel = (): void => {
      clearLayer();
      setEditing(null);
    };
    setLayer(() =>
      keymap.registerLayer({
        enabled,
        priority: LAYER.MODAL,
        commands: [
          uiCommand({
            id: "editor.commit",
            title: "Commit field",
            description: `Apply ${label}`,
            category: "primary",
            surfaces: ["footer"],
            footerLabel: "commit",
            hintPriority: 100,
            hintGroup: "primary",
            run: apply,
          }),
          uiCommand({
            id: "editor.cancel",
            title: "Cancel field edit",
            description: `Discard changes to ${label}`,
            category: "escape",
            surfaces: ["footer"],
            footerLabel: "cancel",
            hintPriority: 90,
            hintGroup: "escape",
            run: cancel,
          }),
        ],
        bindings: [
          { key: "return", cmd: "editor.commit" },
          { key: "escape", cmd: "editor.cancel" },
          ...GUARDS,
        ],
      }),
    );
    setEditing({ mode: "text", label, current });
  }

  function startSecret(label: string, commit: (value: string) => void): void {
    value = "";
    const apply = (): void => {
      clearLayer();
      const v = value;
      value = "";
      setEditing(null);
      commit(v);
    };
    const cancel = (): void => {
      clearLayer();
      value = "";
      setEditing(null);
    };
    setLayer(() =>
      keymap.registerLayer({
        enabled,
        priority: LAYER.MODAL,
        commands: [
          uiCommand({
            id: "editor.secret.save",
            title: "Save secret",
            description: `Save ${label} without revealing it`,
            category: "primary",
            surfaces: ["footer"],
            footerLabel: "save",
            hintPriority: 100,
            hintGroup: "primary",
            run: apply,
          }),
          uiCommand({
            id: "editor.cancel",
            title: "Cancel secret edit",
            description: `Discard ${label}`,
            category: "escape",
            surfaces: ["footer"],
            footerLabel: "cancel",
            hintPriority: 90,
            hintGroup: "escape",
            run: cancel,
          }),
        ],
        bindings: [
          { key: "return", cmd: "editor.secret.save" },
          { key: "escape", cmd: "editor.cancel" },
          { key: "left", cmd: noop },
          { key: "right", cmd: noop },
          { key: "up", cmd: noop },
          { key: "down", cmd: noop },
          { key: "home", cmd: noop },
          { key: "end", cmd: noop },
          ...GUARDS,
        ],
      }),
    );
    setEditing({ mode: "secret", label });
  }

  function startNumber(label: string, current: number | undefined, opts: NumberFieldOpts): void {
    value = current != null ? String(current) : "";
    const apply = (): void => {
      const raw = value.trim();
      if (raw === "") {
        clearLayer();
        setEditing(null);
        if (current !== undefined) opts.commit(undefined);
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        opts.notify(`invalid number: ${raw}`);
        return;
      }
      const v = Math.floor(n);
      if (opts.min != null && v < opts.min) {
        opts.notify(`must be ${glyph("greaterOrEqual")} ${opts.min}`);
        return;
      }
      if (opts.max != null && v > opts.max) {
        opts.notify(`must be ${glyph("lessOrEqual")} ${opts.max}`);
        return;
      }
      clearLayer();
      setEditing(null);
      if (v !== current) opts.commit(v);
    };
    const cancel = (): void => {
      clearLayer();
      setEditing(null);
    };
    setLayer(() =>
      keymap.registerLayer({
        enabled,
        priority: LAYER.MODAL,
        commands: [
          uiCommand({
            id: "editor.commit",
            title: "Commit number",
            description: `Validate and apply ${label}`,
            category: "primary",
            surfaces: ["footer"],
            footerLabel: "commit",
            hintPriority: 100,
            hintGroup: "primary",
            run: apply,
          }),
          uiCommand({
            id: "editor.cancel",
            title: "Cancel number edit",
            description: `Discard changes to ${label}`,
            category: "escape",
            surfaces: ["footer"],
            footerLabel: "cancel",
            hintPriority: 90,
            hintGroup: "escape",
            run: cancel,
          }),
        ],
        bindings: [
          { key: "return", cmd: "editor.commit" },
          { key: "escape", cmd: "editor.cancel" },
          ...GUARDS,
        ],
      }),
    );
    setEditing({ mode: "text", label, current: value });
  }

  function openPick(
    label: string,
    items: PickItem[],
    initial: number,
    commit: (value: string) => void,
    initialValue?: string,
    onManual?: () => void,
  ): void {
    clearLayer();
    pickCommit = commit;
    setEditing({
      mode: "pick",
      label,
      items,
      initial,
      ...(initialValue !== undefined ? { initialValue } : {}),
      ...(onManual !== undefined ? { onManual } : {}),
    });
  }

  function startPick(
    label: string,
    items: PickItem[],
    commit: (value: string) => void,
    opts?: { onManual?: () => void },
  ): void {
    openPick(label, items, 0, commit, undefined, opts?.onManual);
  }

  function startEnum(
    label: string,
    options: readonly (string | PickItem)[],
    current: string | undefined,
    commit: (value: string) => void,
  ): void {
    const items = options.map((o) => (typeof o === "string" ? { label: o, value: o } : o));
    const initial =
      current === undefined
        ? 0
        : Math.max(
            0,
            items.findIndex((it) => it.value === current),
          );
    openPick(label, items, initial, commit, current);
  }

  function startMultiline(label: string, current: string, commit: (value: string) => void): void {
    multiline = undefined;
    const done = (apply: boolean): void => {
      clearLayer();
      const text = multiline?.plainText ?? current;
      multiline = undefined;
      setEditing(null);
      if (apply) commit(text);
    };
    setLayer(() => {
      const offCommands = keymap.registerLayer({
        enabled,
        priority: LAYER.MODAL,
        commands: [
          uiCommand({
            id: "editor.multiline.apply",
            title: "Apply text",
            description: `Apply changes to ${label}`,
            category: "primary",
            surfaces: ["footer"],
            footerLabel: "apply",
            hintPriority: 100,
            hintGroup: "primary",
            run: () => done(true),
          }),
          uiCommand({
            id: "editor.cancel",
            title: "Cancel text edit",
            description: `Discard changes to ${label}`,
            category: "escape",
            surfaces: ["footer"],
            footerLabel: "cancel",
            hintPriority: 90,
            hintGroup: "escape",
            run: () => done(false),
          }),
        ],
      });
      const offInput = registerManagedTextareaLayer(keymap, interaction.renderer, {
        enabled,
        priority: LAYER.MODAL,
        bindings: createTextareaBindings([
          { key: "escape", cmd: "editor.cancel" },
          { key: "ctrl+s", cmd: "editor.multiline.apply" },
          { key: "ctrl+t", cmd: noop },
        ]),
      });
      return () => {
        offInput();
        offCommands();
      };
    });
    setEditing({ mode: "multiline", label, current });
  }

  function EditInput(): JSX.Element {
    const st = editing()!;
    if (st.mode === "text") {
      return (
        <box
          border
          borderStyle="rounded"
          customBorderChars={borderChars()}
          borderColor={tokens.accent}
          backgroundColor={tokens.bg}
          zIndex={1}
          paddingLeft={1}
          flexShrink={0}
        >
          <text fg={tokens.muted}>{st.label + ":  "}</text>
          <input
            ref={(el: InputRenderable) => {
              focusedInput = el;
              el.onContentChange = () => (value = el.value);
              el.value = st.current;
              value = st.current;
              if (active()) queueMicrotask(() => el.focus());
            }}
            textColor={tokens.fg}
            focusedTextColor={tokens.fg}
          />
        </box>
      );
    }
    if (st.mode === "secret") {
      return (
        <box
          border
          borderStyle="rounded"
          customBorderChars={borderChars()}
          borderColor={tokens.accent}
          backgroundColor={tokens.bg}
          zIndex={1}
          paddingLeft={1}
          flexShrink={0}
        >
          <text fg={tokens.muted}>{st.label + ":  "}</text>
          <input
            ref={(el: InputRenderable) => {
              focusedInput = el;
              let guard = false;
              el.onCursorChange = () => {
                if (guard) return;
                guard = true;
                if (el.hasSelection()) el.clearSelection();
                if (el.cursorOffset !== el.plainText.length) el.cursorOffset = el.plainText.length;
                guard = false;
              };
              el.onContentChange = () => {
                if (guard) return;
                const mask = secretMask();
                const v = el.value;
                const cap = Math.min(value.length, v.length);
                let kept = 0;
                while (kept < cap && v[kept] === mask) kept++;
                value = value.slice(0, kept) + v.slice(kept);
                guard = true;
                el.value = mask.repeat(value.length);
                el.cursorOffset = value.length;
                guard = false;
              };
              value = "";
              if (active()) queueMicrotask(() => el.focus());
            }}
            textColor={tokens.fg}
            focusedTextColor={tokens.fg}
          />
          <text fg={tokens.muted} flexShrink={0}>
            input hidden
          </text>
        </box>
      );
    }
    if (st.mode === "multiline") {
      return (
        <box
          border
          borderStyle="rounded"
          customBorderChars={borderChars()}
          borderColor={tokens.accent}
          backgroundColor={tokens.bg}
          zIndex={1}
          paddingLeft={1}
          flexShrink={0}
          flexDirection="column"
        >
          <text fg={tokens.muted}>{st.label}</text>
          <textarea
            minHeight={6}
            maxHeight={12}
            ref={(el: TextareaRenderable) => {
              multiline = el;
              focusedInput = el;
              el.setText(st.current);
              if (active())
                queueMicrotask(() => {
                  el.focus();
                  el.gotoBufferEnd();
                });
            }}
            textColor={tokens.fg}
            focusedTextColor={tokens.fg}
          />
          <text fg={tokens.muted}>Enter inserts a newline.</text>
        </box>
      );
    }
    return <></>;
  }

  const pickRow = (it: PickItem): CatalogRow => ({
    id: it.value,
    label: it.label,
    haystack: it.label + " " + it.value,
    ...(it.detail !== undefined ? { detail: it.detail } : {}),
  });
  const pickerSpec = (): CatalogPickerSpec | null => {
    const st = editing();
    if (st?.mode !== "pick") return null;
    const done = (picked?: string): void => {
      const commit = pickCommit;
      pickCommit = null;
      setEditing(null);
      if (picked !== undefined && picked !== st.initialValue) commit?.(picked);
    };
    return {
      title: st.label,
      rows: () => st.items.map(pickRow),
      onPick: (id) => done(id),
      onClose: () => done(),
      ...(st.items[st.initial]?.value !== undefined
        ? { initialId: st.items[st.initial]!.value }
        : {}),
      ...(st.initialValue !== undefined ? { currentId: st.initialValue } : {}),
      ...(st.onManual
        ? {
            onManual: () => {
              pickCommit = null;
              setEditing(null);
              st.onManual!();
            },
          }
        : {}),
    };
  };

  function PickerInput(): JSX.Element {
    return (
      <SurfaceBoundary
        active={() => active() && editing()?.mode === "pick"}
        retention="retain-one"
        placement="portal"
      >
        {(lifecycle) => (
          <CatalogPicker keymap={keymap} spec={pickerSpec} active={lifecycle.active} />
        )}
      </SurfaceBoundary>
    );
  }

  return {
    editing,
    start,
    startSecret,
    startNumber,
    startPick,
    startEnum,
    startMultiline,
    EditInput,
    PickerInput,
  };
}
