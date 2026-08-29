/**
 * The executor and the guard analyzer must never disagree about which shell runs.
 *
 * @remarks A guard that parses POSIX while PowerShell executes produces no error
 * and no failing test — it just rules on a language nobody is running, and every
 * pattern it holds silently stops matching. Three files say in prose that both
 * sides derive from one `currentShellFlavor` call, and until this test was
 * written that was not quite true: `computeShell` made its own `=== "win32"`
 * comparison. The two agreed, so nothing was broken; what was missing was the
 * property the prose claimed — that disagreement is *unrepresentable* rather
 * than merely absent today.
 *
 * The scan looks for the shape of the mistake rather than a known call site: any
 * `src` module deciding shell syntax from the platform without going through the
 * one function that owns the derivation.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { currentShellFlavor } from "../../src/lib/platform.ts";
import { currentDialect } from "../../src/guard/dialects/index.ts";
import { resolveShell } from "../../src/shell.ts";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(PKG, "src");

/** The single module allowed to turn a platform into a shell flavor. */
const OWNER = "src/lib/platform.ts";

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...sources(abs));
    else if (abs.endsWith(".ts")) out.push(abs);
  }
  return out;
}

const rel = (file: string): string => relative(PKG, file).split("\\").join("/");

/**
 * What marks a platform read as *producing a shell flavor*, rather than merely
 * mentioning a shell.
 *
 * @remarks Deliberately narrow. `systemExecutableRoots` and several filesystem
 * or process helpers branch on `win32`, but none decides the language the guard
 * parses; a looser word list flagged those unrelated platform decisions. A line
 * only counts when the platform decides a `flavor` or names `powershell` as a
 * value.
 */
const PRODUCES_A_FLAVOR = /powershell|flavor/i;

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

/**
 * `<path>:<line>` for every line that decides shell syntax from the platform
 * without routing through {@link currentShellFlavor}.
 */
function independentDerivations(): string[] {
  const found: string[] = [];
  for (const file of sources(SRC)) {
    const path = rel(file);
    if (path === OWNER) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (isComment(line)) return;
        if (!line.includes("process.platform") && !line.includes('"win32"')) return;
        if (!PRODUCES_A_FLAVOR.test(line)) return;
        if (line.includes("currentShellFlavor")) return;
        found.push(`${path}:${String(i + 1)}`);
      });
  }
  return found;
}

describe("one derivation decides which shell this host speaks", () => {
  it("scans a non-trivial number of files, so a green run means something", () => {
    expect(sources(SRC).length).toBeGreaterThan(30);
  });

  it("no module outside the owner derives a shell flavor from the platform", () => {
    expect(independentDerivations()).toEqual([]);
  });

  it("sees the mistake when it is reintroduced", () => {
    const reintroduced = 'const flavor = process.platform === "win32" ? "powershell" : "posix";';
    expect(PRODUCES_A_FLAVOR.test(reintroduced)).toBe(true);
    expect(reintroduced.includes("currentShellFlavor")).toBe(false);
  });

  it("the executor and the analyzer answer the same for every host", () => {
    for (const platform of ["win32", "linux", "darwin", "freebsd"] as const) {
      const flavor = currentShellFlavor(platform);
      expect(currentDialect(platform).flavor).toBe(flavor);
      expect(resolveShell({ platform, lookup: () => undefined, systemRoot: "C:\\W" }).flavor).toBe(
        flavor,
      );
    }
  });
});
