/** Solid-free mark table and resolver. Theme UI wraps this with reactive ascii state. */

/** The Unicode and ASCII renderings of a single mark. */
export type MarkForms = {
  readonly unicode: string;
  readonly ascii: string;
};

const MARKS = {
  success: { unicode: "✓", ascii: "[ok]" },
  warning: { unicode: "⚠", ascii: "[!]" },
  error: { unicode: "✗", ascii: "[x]" },
  pending: { unicode: "○", ascii: "[ ]" },
  skipped: { unicode: "⊘", ascii: "[-]" },
  info: { unicode: "ⓘ", ascii: "[i]" },

  close: { unicode: "x", ascii: "x" },
  chevronRight: { unicode: "▸", ascii: ">" },
  chevronLeft: { unicode: "◂", ascii: "<" },
  caretUp: { unicode: "▴", ascii: "^" },
  caretDown: { unicode: "▾", ascii: "v" },
  expand: { unicode: "▸", ascii: ">" },
  collapse: { unicode: "▾", ascii: "v" },

  arrowRight: { unicode: "→", ascii: "->" },
  arrowLeft: { unicode: "←", ascii: "<-" },
  arrowUp: { unicode: "↑", ascii: "^" },
  arrowDown: { unicode: "↓", ascii: "v" },
  arrowUpRight: { unicode: "↗", ascii: "^>" },
  arrowDownRight: { unicode: "↘", ascii: "v>" },
  return: { unicode: "↵", ascii: "<CR>" },

  dotFull: { unicode: "●", ascii: "*" },
  dotEmpty: { unicode: "○", ascii: "o" },
  radioOn: { unicode: "(◉)", ascii: "(*)" },
  radioOff: { unicode: "( )", ascii: "( )" },
  bullet: { unicode: "•", ascii: "*" },
  diamond: { unicode: "◆", ascii: "#" },
  lock: { unicode: "⚷", ascii: "*" },
  spark: { unicode: "✦", ascii: "*" },
  branch: { unicode: "├", ascii: "|" },
  leaf: { unicode: "└", ascii: "`" },

  treeVertical: { unicode: "│", ascii: "|" },
  treeBranch: { unicode: "├─", ascii: "|-" },
  treeLast: { unicode: "└─", ascii: "`-" },
  treeSpace: { unicode: "  ", ascii: "  " },

  horizontal: { unicode: "─", ascii: "-" },
  vertical: { unicode: "│", ascii: "|" },
  rail: { unicode: "▌", ascii: "|" },
  block: { unicode: "█", ascii: "#" },
  shadeDark: { unicode: "▓", ascii: "#" },
  shadeMedium: { unicode: "▒", ascii: "=" },
  shadeLight: { unicode: "░", ascii: "." },

  separator: { unicode: "·", ascii: "." },
  emDash: { unicode: "—", ascii: "--" },
  enDash: { unicode: "-", ascii: "-" },
  ellipsis: { unicode: "…", ascii: "..." },
  colon: { unicode: ":", ascii: ":" },
  prime: { unicode: "'", ascii: "'" },

  plus: { unicode: "+", ascii: "+" },
  minus: { unicode: "-", ascii: "-" },
  multiply: { unicode: "x", ascii: "*" },
  lessOrEqual: { unicode: "≤", ascii: "<=" },
  greaterOrEqual: { unicode: "≥", ascii: ">=" },

  command: { unicode: "⌘", ascii: "$" },
  home: { unicode: "⌂", ascii: "~" },
  image: { unicode: "▣", ascii: "[img]" },
  file: { unicode: "▤", ascii: "[file]" },
  folder: { unicode: "▰", ascii: "[dir]" },

  superscriptW: { unicode: "ᵂ", ascii: "w" },
  superscriptG: { unicode: "ᴳ", ascii: "g" },
} as const satisfies Record<string, MarkForms>;

/** Name of a mark defined in the shared {@link MarkForms} table. */
export type MarkName = keyof typeof MARKS;

/** Compatibility aliases used by the existing theme surface. */
export type GlyphForms = MarkForms;
export type GlyphName = MarkName;
export const GLYPHS = MARKS;

// Rich terminal glyphs are the normal presentation. ASCII remains an explicit
// compatibility mode selected through code.json or `--ascii`.
let asciiEnabled = false;

/**
 * Sets the module-wide default for whether {@link mark} resolves to ASCII or Unicode.
 *
 * @param on - `true` to default marks to their ASCII form.
 */
export function applyAsciiMode(on: boolean): void {
  asciiEnabled = on;
}

/** Reports the current module-wide ASCII-mode default set by {@link applyAsciiMode}. */
export function asciiMode(): boolean {
  return asciiEnabled;
}

/**
 * Resolves a mark to its rendered form.
 *
 * @param name - The mark to resolve.
 * @param ascii - Overrides the module-wide default from {@link applyAsciiMode} for this call.
 * @returns The ASCII or Unicode rendering of the mark.
 */
export function mark(name: MarkName, ascii = asciiEnabled): string {
  const g = MARKS[name];
  return ascii ? g.ascii : g.unicode;
}

/** @deprecated Prefer `mark`; kept so theme and UI keep a familiar name. */
export function glyph(name: MarkName, ascii = asciiEnabled): string {
  return mark(name, ascii);
}

const ASCII_BORDER = {
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  horizontal: "-",
  vertical: "|",
  topT: "+",
  bottomT: "+",
  leftT: "+",
  rightT: "+",
  cross: "+",
} as const;

/**
 * Resolves border-drawing characters for ASCII mode.
 *
 * @param ascii - Overrides the module-wide default from {@link applyAsciiMode} for this call.
 * @returns The ASCII border character set, or `undefined` to let the caller use its Unicode default.
 */
export function borderChars(ascii = asciiEnabled): typeof ASCII_BORDER | undefined {
  return ascii ? ASCII_BORDER : undefined;
}
