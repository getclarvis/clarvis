/**
 * There is exactly one way out of this package, and it is not the terminal.
 *
 * @remarks
 * `@clarvis/code` boots the kernel with a silent logger and then owns the
 * terminal as a canvas. A `process.stderr.write` from a tool paints over the
 * renderer's own frame, past the silencing the host asked for — and until the
 * host installed the sink, that is exactly what one unreadable `.gitignore`
 * did. Routing everything through
 * {@link "../../src/lib/log.js" | ToolsLogger} or the single `WarnSink` is what
 * makes the host's choice binding, so a new direct write must fail here rather
 * than be discovered on someone's screen.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(PKG, "src");

/** The one module allowed to hold the default `stderr` writer. */
const SANCTIONED = "lib/log.ts";

const FORBIDDEN = [
  { name: "process.stderr", pattern: /\bprocess\s*\.\s*stderr\b/ },
  { name: "process.stdout", pattern: /\bprocess\s*\.\s*stdout\b/ },
  { name: "console.*", pattern: /\bconsole\s*\.\s*[a-z]/ },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("the tools' diagnostics have one channel", () => {
  const files = sourceFiles(SRC);

  it("scans the whole source tree", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it.each(FORBIDDEN)("no src module writes through $name", ({ pattern }) => {
    const offenders = files
      .map((file) => ({
        rel: relative(SRC, file).split("\\").join("/"),
        text: readFileSync(file, "utf8"),
      }))
      .filter(({ rel }) => rel !== SANCTIONED)
      .filter(({ text }) => pattern.test(text))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it("the sanctioned writer is the warn sink's default, and nothing else", () => {
    const code = readFileSync(join(SRC, SANCTIONED), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code.match(/process\s*\.\s*stderr/g)).toHaveLength(1);
    expect(/\bconsole\s*\.\s*[a-z]/.test(code)).toBe(false);
    expect(/\bprocess\s*\.\s*stdout\b/.test(code)).toBe(false);
  });
});
