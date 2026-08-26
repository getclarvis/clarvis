import type { FieldEditor } from "./view-host.tsx";
import { glyph } from "../../theme/glyphs.ts";

/** Callbacks and display context for {@link promptForApiKey}'s secret prompt. */
export interface KeyEntryDeps {
  /** Reports the outcome (e.g. an empty submission) to the user. */
  notify: (message: string) => void;
  /** Optional parenthetical shown next to the env var name, e.g. which provider uses it. */
  usageNote?: string;
  /** Called with the trimmed, non-empty key once the user submits one. */
  commit: (value: string) => void;
}

/**
 * Opens a masked (secret) field editor prompt for an API key bound to `envVar`.
 *
 * @remarks
 * A blank submission is treated as "leave unchanged": it notifies and never
 * calls {@link KeyEntryDeps.commit}.
 */
export function promptForApiKey(fe: FieldEditor, envVar: string, deps: KeyEntryDeps): void {
  const label = deps.usageNote
    ? `API key ${glyph("arrowRight")} ${envVar}  (${deps.usageNote})`
    : `API key ${glyph("arrowRight")} ${envVar}`;
  fe.startSecret(label, (raw) => {
    const value = raw.trim();
    if (!value) {
      deps.notify("empty " + glyph("emDash") + " key unchanged");
      return;
    }
    deps.commit(value);
  });
}
