/**
 * Diagnostics have one channel, in every package — not just in the one that checks.
 *
 * @remarks `@clarvis/tools` has enforced this for itself since the day an
 * unreadable `.gitignore` painted a warning over `@clarvis/code`'s frame. The
 * rule it encodes is repository-wide: Clarvis's kernel wire and an MCP stdio
 * child both use stdout for framed JSON, and `code` owns the terminal, so a
 * stray write from any package corrupts a protocol or a rendered screen. Every
 * other package held the rule by inspection alone.
 *
 * The exemptions are categorised rather than listed flat, because the category
 * is the argument. A CLI entrypoint writes to a terminal an operator is looking
 * at, before any host exists to route through; a package's single sanctioned
 * sink is where the channel *ends*; stream plumbing names a stream without
 * writing diagnostics to it. Adding a file means claiming one of those, which is
 * a reviewable act — unlike appending to an undifferentiated allowlist.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..", "..", "..");

const FORBIDDEN = [
  { name: "process.stdout", pattern: /\bprocess\s*\.\s*stdout\b/ },
  { name: "process.stderr", pattern: /\bprocess\s*\.\s*stderr\b/ },
  { name: "console.*", pattern: /\bconsole\s*\.\s*[a-z]/ },
  { name: "process.emitWarning", pattern: /\bprocess\s*\.\s*emitWarning\b/ },
];

/**
 * `@clarvis/code` owns the terminal outright: it is the renderer, so writing to
 * the screen is its whole job rather than a leak past a host's choice.
 */
const OWNS_THE_TERMINAL = "packages/code/";

/**
 * A package's CLI entrypoint. Its reader is an operator at a shell, before a
 * logger or a kernel exists — the case the observability standard explicitly
 * carves out for `--help` and boot failures.
 */
const CLI_ENTRYPOINTS = new Set(["packages/kernel/src/bin.ts", "packages/server/src/bin.ts"]);

/** The one module in a package permitted to hold its default writer. */
const SANCTIONED_SINKS = new Set([
  "packages/tools/src/lib/log.ts",
  "packages/skills/src/lib/log.ts",
  "packages/loop/src/logger.ts",
]);

/**
 * Files that name a stream as a destination or a child's handle rather than
 * writing diagnostics: the kernel's own JSON wire, a hook subprocess's pipes,
 * and an MCP stdio child's streams.
 */
const STREAM_PLUMBING = new Set([
  "packages/kernel/src/serve.ts",
  "packages/kernel/src/runtime/guest-main.ts",
  "packages/hooks/src/subprocess.ts",
  "packages/mcp-client/src/bun-stdio-client.ts",
]);

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

function exempt(rel: string): boolean {
  return (
    rel.startsWith(OWNS_THE_TERMINAL) ||
    CLI_ENTRYPOINTS.has(rel) ||
    SANCTIONED_SINKS.has(rel) ||
    STREAM_PLUMBING.has(rel)
  );
}

async function scanned(): Promise<{ rel: string; text: string }[]> {
  const out: { rel: string; text: string }[] = [];
  for await (const match of new Glob("packages/*/src/**/*.{ts,tsx}").scan({ cwd: repoRoot })) {
    const rel = match.split(sep).join("/");
    out.push({ rel, text: await readFile(join(repoRoot, match), "utf8") });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** `<path>:<line> <channel>` for every unsanctioned direct write. */
async function offenders(): Promise<string[]> {
  const found: string[] = [];
  for (const { rel, text } of await scanned()) {
    if (exempt(rel)) continue;
    text.split("\n").forEach((line, i) => {
      if (isComment(line)) return;
      for (const { name, pattern } of FORBIDDEN) {
        if (pattern.test(line)) found.push(`${rel}:${String(i + 1)} ${name}`);
      }
    });
  }
  return found;
}

describe("every package routes diagnostics through the Logger port", () => {
  test("scans the whole monorepo, so a green run means something", async () => {
    const files = await scanned();
    expect(files.length).toBeGreaterThan(400);
    expect(new Set(files.map((f) => f.rel.split("/")[1])).size).toBeGreaterThanOrEqual(15);
  });

  test("no package writes to a terminal channel directly", async () => {
    expect(await offenders()).toEqual([]);
  });

  test("every named exemption still exists and still needs to be one", async () => {
    const byPath = new Map((await scanned()).map((f) => [f.rel, f.text]));
    const stale: string[] = [];
    for (const rel of [...CLI_ENTRYPOINTS, ...SANCTIONED_SINKS, ...STREAM_PLUMBING]) {
      const text = byPath.get(rel);
      if (text === undefined) {
        stale.push(`${rel} (missing)`);
        continue;
      }
      const writes = text
        .split("\n")
        .some((line) => !isComment(line) && FORBIDDEN.some(({ pattern }) => pattern.test(line)));
      if (!writes) stale.push(`${rel} (no longer writes directly)`);
    }
    expect(stale).toEqual([]);
  });

  test("the matcher recognises each channel it names", () => {
    const lines = [
      'process.stdout.write("x");',
      "process.stderr.write(msg);",
      'console.error("boom");',
      'process.emitWarning("deprecated");',
    ];
    for (const line of lines) {
      expect(FORBIDDEN.some(({ pattern }) => pattern.test(line))).toBe(true);
    }
  });

  test("the matcher leaves prose naming the channel alone", () => {
    for (const line of [
      " * never write to process.stdout from a package",
      "// console.log is out",
    ]) {
      expect(isComment(line)).toBe(true);
    }
  });
});
