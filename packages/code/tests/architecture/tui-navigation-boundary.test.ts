import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test } from "bun:test";

const SRC = join(import.meta.dir, "..", "..", "src");

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.[cm]?[jt]sx?$/.test(entry.name)
        ? [path]
        : [];
  });
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("navigation labels have no legacy static source of truth", () => {
  const obsolete = ["defaultKeyHint", "PANEL_KEY_LEGEND", "hintLine(", "scrollHint("];
  const offenders = sourceFiles(SRC).flatMap((file) => {
    const source = stripComments(readFileSync(file, "utf8"));
    return obsolete
      .filter((token) => source.includes(token))
      .map((token) => ({ file: relative(SRC, file).split(sep).join("/"), token }));
  });
  expect(offenders).toEqual([]);
});

test("ordinary screens do not embed bracketed shortcut instructions", () => {
  // FatalBoot runs before the shared keymap exists. KeyboardView's probe labels
  // are inputs under test, not navigation instructions. `keyspec` is the real
  // prompt binding declaration consumed by InputDock.
  const allowed = new Set([
    "views/FatalBoot.tsx",
    "views/config/KeyboardView.tsx",
    "keys/keyspec.ts",
  ]);
  const visibleShortcut =
    /\[(?:esc|enter|return|f\d+|\^?[a-z0-9+/-]+)\]\s+(?:add|back|cancel|close|commands|confirm|delete|edit|expand|full-screen|move|open|quit|refresh|remove|retry|save|scroll|select|start)|(?:ctrl|alt|option|cmd|super)\+[a-z0-9+/-]+\s+to\s+\w+|(?:press|with|using)\s+\[(?:esc|enter|return|f\d+|\^?[a-z0-9+/-]+)\]/i;
  const offenders = sourceFiles(SRC).flatMap((file) => {
    const rel = relative(SRC, file).split(sep).join("/");
    if (allowed.has(rel)) return [];
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    return lines.flatMap((line, index) =>
      visibleShortcut.test(line) || line.includes('glyph("return")')
        ? [{ file: rel, line: index + 1, text: line.trim() }]
        : [],
    );
  });
  expect(offenders).toEqual([]);
});

test("shared frames accept action projection instead of static key-hint props", () => {
  const footer = readFileSync(join(SRC, "views", "Footer.tsx"), "utf8");
  const page = readFileSync(join(SRC, "views", "PageFrame.tsx"), "utf8");
  const view = readFileSync(join(SRC, "ui", "patterns", "view-frame.tsx"), "utf8");
  expect(footer).not.toContain("keyHint?:");
  expect(page).not.toContain("hint?: string");
  expect(view).not.toContain("footer: string");
  expect(footer).toContain("navigation?: JSX.Element");
  expect(page).toContain("interaction: Interaction");
  expect(view).toContain("InteractionNavigationBar");
});

test("window-local Escape bindings never claim the global Ctrl+C route", () => {
  const offenders = sourceFiles(SRC).flatMap((file) => {
    const source = stripComments(readFileSync(file, "utf8"));
    const escapeBindings = [...source.matchAll(/\{\s*key:\s*"escape",\s*cmd:/g)];
    return escapeBindings.flatMap((binding) => {
      const nearbyBindings = source.slice(binding.index, binding.index + 240);
      return /\{\s*key:\s*"ctrl\+c",\s*cmd:/.test(nearbyBindings)
        ? [{ file: relative(SRC, file).split(sep).join("/"), offset: binding.index }]
        : [];
    });
  });
  expect(offenders).toEqual([]);
});
