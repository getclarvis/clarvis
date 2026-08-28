/**
 * Clarvis shares `.agents` with other runtimes, with mutation authority scoped
 * to managed plugin installations rather than the whole convention tree.
 *
 * @remarks `invariant.test.ts` ensures only `@clarvis/paths` spells this layout.
 * This complementary scan enforces ownership after a consumer obtains one of
 * those accessors: standalone skills and marketplace documents remain authored
 * input, while exactly the filesystem plugin repository may create, replace or
 * remove an exact directory below `.agents/plugins`.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..", "..", "..");

/** Shared authored inputs that Clarvis only discovers. */
const READ_ONLY_ACCESSORS = ["agentsSkillsDirs", "agentsMarketplaceFile", "agentsMarketplaceFiles"];

/** Shared plugin inventory roots with a deliberately narrow managed writer. */
const PLUGIN_ACCESSORS = ["agentsPluginsDir", "agentsPluginsDirs"];

const AGENTS_ACCESSORS = [...READ_ONLY_ACCESSORS, ...PLUGIN_ACCESSORS];

const PLUGIN_WRITER = "packages/kernel/src/adapters/filesystem/plugin-repository.ts";

/** Calls that create, modify or remove something on disk. */
const MUTATORS = [
  "writeFile",
  "writeFileSync",
  "writeFileDurable",
  "appendFile",
  "appendFileSync",
  "mkdir",
  "mkdirSync",
  "rm",
  "rmSync",
  "rmdir",
  "unlink",
  "unlinkSync",
  "rename",
  "renameSync",
  "renameWithRetry",
  "copyFile",
  "copyFileSync",
  "chmod",
  "chmodSync",
  "truncate",
  "createWriteStream",
  "ensureWorkspaceDir",
  "ensureWorkspaceSubdir",
];

const SCANNED = ["packages/*/src/**/*.{ts,tsx}", "packages/*/tooling/**/*.{ts,tsx}"];

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

/** Files outside this package that import an `.agents` accessor. */
async function consumers(
  accessors: readonly string[] = AGENTS_ACCESSORS,
): Promise<{ rel: string; text: string }[]> {
  const out: { rel: string; text: string }[] = [];
  for (const pattern of SCANNED) {
    for await (const match of new Glob(pattern).scan({ cwd: repoRoot })) {
      const rel = match.split(sep).join("/");
      if (rel.startsWith("packages/paths/")) continue;
      const text = await readFile(join(repoRoot, match), "utf8");
      if (accessors.some((fn) => text.includes(fn))) out.push({ rel, text });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Names bound from an `.agents` accessor in one file — both `const x = fn(...)`
 * and the destructured `const { user, workspace } = fn()` form.
 */
function boundNames(text: string, accessors: readonly string[] = AGENTS_ACCESSORS): string[] {
  const names = new Set<string>();
  const call = accessors.join("|");
  for (const m of text.matchAll(new RegExp(`const\\s+(\\w+)\\s*=\\s*(?:${call})\\s*\\(`, "g"))) {
    names.add(m[1]!);
  }
  for (const m of text.matchAll(
    new RegExp(`const\\s*\\{([^}]*)\\}\\s*=\\s*(?:${call})\\s*\\(`, "g"),
  )) {
    for (const part of m[1]!.split(",")) {
      const name = part.split(":").pop()!.trim();
      if (name !== "") names.add(name);
    }
  }
  return [...names];
}

/** `<path>:<line>` wherever such a name reaches a mutating call. */
async function writes(accessors: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const { rel, text } of await consumers(accessors)) {
    const names = boundNames(text, accessors);
    if (names.length === 0) continue;
    const reaching = new RegExp(
      `\\b(?:${MUTATORS.join("|")})\\s*\\([^)]*\\b(?:${names.join("|")})\\b`,
    );
    text.split("\n").forEach((line, i) => {
      if (isComment(line)) return;
      if (reaching.test(line)) found.push(`${rel}:${String(i + 1)}`);
    });
  }
  return found;
}

/** Consumers that both reach a plugin root and contain a direct filesystem mutation. */
async function pluginWriters(): Promise<string[]> {
  const mutator = new RegExp(`\\b(?:${MUTATORS.join("|")})\\s*\\(`);
  const found: string[] = [];
  for (const { rel, text } of await consumers(PLUGIN_ACCESSORS)) {
    if (text.split("\n").some((line) => !isComment(line) && mutator.test(line))) found.push(rel);
  }
  return found;
}

describe(".agents ownership stays explicit and component-scoped", () => {
  test("the scan finds the consumers it exists to check", async () => {
    const files = await consumers();
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files.some(({ text }) => boundNames(text).length > 0)).toBe(true);
  });

  test("standalone skill and marketplace paths never reach a mutating call", async () => {
    expect(await writes(READ_ONLY_ACCESSORS)).toEqual([]);
  });

  test("only the plugin repository has direct mutation authority beside a shared plugin root", async () => {
    expect(await pluginWriters()).toEqual([PLUGIN_WRITER]);
  });

  test("the matcher recognises the write it is looking for", () => {
    const text =
      "const agents = agentsSkillsDirs({});\nawait mkdir(agents.user, {recursive: true});";
    expect(boundNames(text)).toEqual(["agents"]);
    const reaching = new RegExp(`\\b(?:${MUTATORS.join("|")})\\s*\\([^)]*\\b(?:agents)\\b`);
    expect(text.split("\n").some((l) => reaching.test(l))).toBe(true);
  });

  test("the matcher leaves an ordinary read alone", () => {
    const text = "const agents = agentsSkillsDirs({});\nconst found = readFileSync(other.path);";
    const reaching = new RegExp(`\\b(?:${MUTATORS.join("|")})\\s*\\([^)]*\\b(?:agents)\\b`);
    expect(text.split("\n").some((l) => reaching.test(l))).toBe(false);
  });
});
