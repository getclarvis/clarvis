import { SyntaxStyle, type CliRenderer } from "@opentui/core";
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  untrack,
  type Accessor,
} from "solid-js";
import { tokens } from "./tokens.ts";
import { mixHex } from "./model.ts";

interface RendererBinding {
  renderer: CliRenderer;
  lastFrame: number;
  off: () => void;
}

interface RetiredStyle {
  style: SyntaxStyle;
  targets: Map<RendererBinding, number>;
}

const rendererBindings = new Set<RendererBinding>();
const retiredStyles: RetiredStyle[] = [];
const unboundRetired: SyntaxStyle[] = [];
const destroyedStyles = new WeakSet<SyntaxStyle>();

function destroyStyle(style: SyntaxStyle): void {
  if (destroyedStyles.has(style)) return;
  destroyedStyles.add(style);
  style.destroy();
}

function flushRetiredStyles(): void {
  for (let index = retiredStyles.length - 1; index >= 0; index -= 1) {
    const retired = retiredStyles[index]!;
    if ([...retired.targets].some(([binding, target]) => binding.lastFrame < target)) continue;
    retiredStyles.splice(index, 1);
    destroyStyle(retired.style);
  }
}

function retireStyle(style: SyntaxStyle): void {
  if (rendererBindings.size === 0) {
    // Direct component tests do not mount the App that binds a renderer. Keep a
    // tiny reserve instead of either leaking every preview generation or
    // destroying a style an unbound test renderer may still hold this frame.
    unboundRetired.push(style);
    while (unboundRetired.length > 2) destroyStyle(unboundRetired.shift()!);
    return;
  }
  retiredStyles.push({
    style,
    targets: new Map([...rendererBindings].map((binding) => [binding, binding.lastFrame + 2])),
  });
}

function buildSyntaxStyle(): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: tokens.fg },
    "markup.heading": { fg: tokens.accent, bold: true },
    "markup.heading.1": { fg: tokens.accent, bold: true },
    "markup.heading.2": { fg: tokens.accent, bold: true },
    "markup.bold": { fg: tokens.fg, bold: true },
    "markup.strong": { fg: tokens.fg, bold: true },
    "markup.italic": { fg: tokens.fg, italic: true },
    "markup.list": { fg: tokens.muted },
    "markup.quote": { fg: tokens.muted },
    "markup.raw": { fg: tokens.add },
    "markup.link": { fg: tokens.accent2 },
    "markup.link.url": { fg: tokens.accent2 },
    comment: { fg: tokens.muted, italic: true },
    keyword: { fg: tokens.accent, bold: true },
    string: { fg: tokens.add },
    number: { fg: tokens.warn },
  });
}

/** The themed SyntaxStyle; superseded native generations retire after two rendered frames. */
export const syntaxStyle: Accessor<SyntaxStyle> = createRoot(() => {
  const [current, setCurrent] = createSignal<SyntaxStyle>();
  createEffect(() => {
    const next = buildSyntaxStyle();
    const previous = untrack(current);
    setCurrent(next);
    if (previous !== undefined) retireStyle(previous);
  });
  return () => current()!;
});

/**
 * Attach native-style retirement to an App renderer's successful frame clock.
 * The returned disposer must run before/during renderer teardown.
 */
export function bindSyntaxStyleRenderer(renderer: CliRenderer): () => void {
  for (const style of unboundRetired.splice(0)) destroyStyle(style);
  const binding = { renderer, lastFrame: 0, off: () => {} } satisfies RendererBinding;
  const onFrame = (event: { frameId: number }): void => {
    binding.lastFrame = event.frameId;
    flushRetiredStyles();
  };
  renderer.on("frame", onFrame);
  binding.off = () => renderer.off("frame", onFrame);
  rendererBindings.add(binding);
  return () => {
    binding.off();
    rendererBindings.delete(binding);
    for (const retired of retiredStyles) retired.targets.delete(binding);
    flushRetiredStyles();
  };
}

/** Test/diagnostic visibility without exposing native style handles. */
export function pendingSyntaxStyleRetirements(): number {
  return retiredStyles.length + unboundRetired.length;
}

/** Themed color props for diff rendering (added/removed tints, gutters), reactive to theme tokens. */
export const diffColorProps = createRoot(() =>
  createMemo(() => {
    const addTint = mixHex(tokens.bg, tokens.add, 0.16);
    const delTint = mixHex(tokens.bg, tokens.del, 0.16);
    const addGutter = mixHex(tokens.bg, tokens.add, 0.28);
    const delGutter = mixHex(tokens.bg, tokens.del, 0.28);
    return {
      fg: tokens.fg,
      addedSignColor: tokens.add,
      removedSignColor: tokens.del,
      lineNumberFg: tokens.muted,
      lineNumberBg: tokens.bgElev,
      addedContentBg: addTint,
      removedContentBg: delTint,
      addedBg: addGutter,
      removedBg: delGutter,
      addedLineNumberBg: addGutter,
      removedLineNumberBg: delGutter,
      contextBg: tokens.bgElev,
      contextContentBg: tokens.bgElev,
    };
  }),
);

const EXT_TO_FILETYPE: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  css: "css",
  scss: "css",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  markdown: "markdown",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  html: "html",
  sql: "sql",
  zig: "zig",
};

/** Maps a file path's extension to a tree-sitter/highlighter filetype id, or `"text"` if unknown or absent. */
export function filetypeFor(path: string | undefined): string {
  if (!path) return "text";
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "text";
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_FILETYPE[ext] ?? "text";
}
