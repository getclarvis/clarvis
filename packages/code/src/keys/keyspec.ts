/**
 * Pure-ish key label helpers and layer priorities used by the command registry.
 * View-level registration and panel verbs live in ui/patterns/level-keys.
 */
import { glyph } from "../theme/glyphs.ts";
import type { ClientPlatform } from "./keyboard-profile.ts";

/**
 * Keymap layer priorities, lowest to highest; a higher layer's bindings win over a lower one's.
 *
 * @remarks `TRANSIENT` exists because `OVERLAY` is not high enough for shell
 *   layers that must sit above the drawer or another mounted surface.
 *   `registerLevel` lifts a level's escape sublayer to `OVERLAY + 1` so escape
 *   survives being layered under a lower-priority nav registration.
 */
export const LAYER = {
  INPUT: 500,
  LIST: 810,
  VITAL: 900,
  OVERLAY: 950,
  TRANSIENT: 955,
  MODAL: 960,
  CONFIRM: 970,
} as const;

function keyName(raw: string): string {
  switch (raw.toLowerCase()) {
    case "escape":
    case "esc":
      return "esc";
    case "enter":
    case "return":
    case "kpenter":
      return glyph("return");
    case "up":
      return glyph("arrowUp");
    case "down":
      return glyph("arrowDown");
    case "left":
      return glyph("arrowLeft");
    case "right":
      return glyph("arrowRight");
    case "pageup":
    case "pgup":
      return "pgup";
    case "pagedown":
    case "pgdn":
      return "pgdn";
    default:
      return raw.length === 1 ? raw.toLowerCase() : raw;
  }
}

/**
 * THE key-label formatter. Every surface that prints a key — footer hints,
 * Help rows, the slash popup, panel legends — renders through here, so one
 * binding can never appear as "meta+r" in one place and "alt+r" in another.
 * Idempotent: feeding an already-compact label back in returns it unchanged.
 */
export function compactKey(token: string, opts: { clientPlatform?: ClientPlatform } = {}): string {
  const t = token.trim();
  if (t === "" || t.startsWith("/")) return t;
  const parts = t.split("+");
  const rawKey = parts[parts.length - 1]!.toLowerCase();
  const modifiedArrow = parts.length > 1 && ["up", "down", "left", "right"].includes(rawKey);
  let key = modifiedArrow ? rawKey : keyName(parts[parts.length - 1]!);
  let prefix = "";
  let shift = false;
  for (const m of parts.slice(0, -1)) {
    const mod = m.toLowerCase();
    if (mod === "ctrl" || mod === "control") prefix += modifiedArrow ? "ctrl+" : "^";
    else if (mod === "cmd") prefix += "cmd+";
    else if (mod === "super") prefix += opts.clientPlatform === "macos" ? "cmd+" : "super+";
    else if (mod === "option") prefix += opts.clientPlatform === "macos" ? "opt+" : "alt+";
    else if (mod === "meta" || mod === "alt")
      prefix += opts.clientPlatform === "macos" ? "opt+" : "alt+";
    else if (mod === "shift") shift = true;
    else prefix += mod + "+";
  }
  if (shift) {
    if (key.length === 1) key = key.toUpperCase();
    else prefix = "shift+" + prefix;
  }
  return prefix + key;
}

/** One parsed binding sequence ("ctrl+x ctrl+s") through the one formatter. */
export function compactSequence(parts: readonly { display: string }[]): string {
  return parts.map((p) => compactKey(p.display)).join(" ");
}

interface BindingLookup {
  getCommandBindings(query: {
    commands: readonly string[];
    visibility?: "reachable" | "active" | "registered";
  }): ReadonlyMap<string, readonly { sequence: readonly { display: string }[] }[]>;
}

/**
 * The keymap-truth key label for a command, or undefined when it has no
 * binding — callers supply their own fallback text.
 */
export function commandKeyLabel(
  keymap: BindingLookup,
  command: string,
  opts: { visibility?: "reachable" | "registered" } = {},
): string | undefined {
  const map = keymap.getCommandBindings({
    commands: [command],
    visibility: opts.visibility ?? "reachable",
  });
  const bindings = map.get(command);
  if (!bindings || bindings.length === 0) return undefined;
  const labels = [...new Set(bindings.map((b) => compactSequence(b.sequence)))];
  return labels.join(" / ");
}

/** One row of the prompt-editing keybindings help table. */
export interface PromptKeyRow {
  /** Dock-registered command name; absent rows document OpenTUI's built-in editor chords. */
  command?: string;
  keys: string[];
  desc: string;
}

/** The prompt editor's keybindings, both dock-registered commands and OpenTUI's built-in chords. */
export const PROMPT_EDITING_KEYS: PromptKeyRow[] = [
  { command: "prompt.send", keys: ["return", "kpenter"], desc: "send (numpad Enter too)" },
  { command: "prompt.newline", keys: ["ctrl+j"], desc: "insert a newline" },
  {
    command: "prompt.historyPrev",
    keys: ["up"],
    desc: "older prompt from history (at the top edge)",
  },
  {
    command: "prompt.historyNext",
    keys: ["down"],
    desc: "newer prompt / the live draft (at the bottom edge)",
  },
  {
    command: "prompt.attachImage",
    keys: ["ctrl+v"],
    desc: "attach an image from the clipboard",
  },
  { keys: ["@"], desc: "mention a workspace file (images attach)" },
  { keys: ["ctrl+a", "ctrl+e"], desc: "start / end of line" },
  { keys: ["ctrl+w"], desc: "delete the previous word" },
  { keys: ["ctrl+k", "ctrl+u"], desc: "delete to end / start of line" },
  { keys: ["ctrl+-", "ctrl+."], desc: "undo / redo" },
];

/** The compact label for a dock command, straight from the shared table. */
export function promptKeyLabel(command: string): string {
  const row = PROMPT_EDITING_KEYS.find((r) => r.command === command);
  if (!row) return "";
  return [...new Set(row.keys.map((key) => compactKey(key)))].join(" / ");
}
