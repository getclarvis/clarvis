import { createEffect, type Accessor, type JSX } from "solid-js";
import type { InputRenderable } from "@opentui/core";
import { tokens } from "../../theme/tokens.ts";

/**
 * A single-line text input for filtering a list, auto-focused on mount.
 *
 * @remarks
 * Reports each keystroke via `onTerm` from the input's own `onContentChange`
 * rather than a controlled `value`, and exposes the underlying
 * `InputRenderable` through `onInput` for callers that need imperative access
 * (e.g. to refocus it).
 */
export function FilterField(props: {
  onTerm: (term: string) => void;
  onInput?: (el: InputRenderable) => void;
  active?: Accessor<boolean>;
}): JSX.Element {
  let input: InputRenderable | undefined;
  createEffect(() => {
    const enabled = props.active?.() ?? true;
    const el = input;
    if (!el) return;
    queueMicrotask(() => {
      if (input !== el) return;
      if (enabled) el.focus();
      else el.blur();
    });
  });
  return (
    <box flexShrink={0} flexDirection="row">
      <text fg={tokens.muted} flexShrink={0}>
        {"filter  "}
      </text>
      <input
        ref={(el: InputRenderable) => {
          input = el;
          el.onContentChange = () => props.onTerm(el.value);
          props.onInput?.(el);
          if (props.active?.() ?? true) queueMicrotask(() => el.focus());
        }}
        flexGrow={1}
        textColor={tokens.fg}
        focusedTextColor={tokens.fg}
      />
    </box>
  );
}
