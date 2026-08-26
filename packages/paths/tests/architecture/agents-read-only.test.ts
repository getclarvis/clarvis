/**
 * Clarvis reads `.agents` and writes `.clarvis`, and nothing enforced the first half.
 *
 * @remarks `invariant.test.ts` is a *textual* scan: it catches a package that
 * spells `.agents` itself, which is how a new location gets built. It cannot
 * catch the other direction — an existing accessor, correctly obtained from this
 * package, being handed to a mutating call. `.agents` is the user's own content,
 * shared with other agent runtimes; writing into it would edit files Clarvis does
 * not own, in a tree no `.gitignore` of ours covers.
 *
 * The scan works from the accessors rather than from the literal: every path
 * under `.agents` comes from one of three functions, so a file that never
 * imports one cannot reach the tree at all, and a file that does gets its bound
 * names traced into every mutating call in it.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..", "..", "..");

/** Every function in this package that answers a path inside `.agents`. */
const AGENTS_ACCESSORS = ["agentsSkillsDirs", "agentsMarketplaceFile", "agentsMarketplaceFiles"];

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
async function consumers(): Promise<{ rel: string; text: string }[]> {
  const out: { rel: string; text: string }[] = [];
  for (const pattern of SCANNED) {
    for await (const match of new Glob(pattern).scan({ cwd: repoRoot })) {
      const rel = match.split(sep).join("/");
      if (rel.startsWith("packages/paths/")) continue;
      const text = await readFile(join(repoRoot, match), "utf8");
      if (AGENTS_ACCESSORS.some((fn) => text.includes(fn))) out.push({ rel, text });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Names bound from an `.agents` accessor in one file — both `const x = fn(...)`
 * and the destructured `const { user, workspace } = fn()` form.
 */
function boundNames(text: string): string[] {
  const names = new Set<string>();
  const call = AGENTS_ACCESSORS.join("|");
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
async function writes(): Promise<string[]> {
  const found: string[] = [];
  for (const { rel, text } of await consumers()) {
    const names = boundNames(text);
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

describe("nothing in the monorepo writes under .agents", () => {
  test("the scan finds the consumers it exists to check", async () => {
    const files = await consumers();
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.some(({ text }) => boundNames(text).length > 0)).toBe(true);
  });

  test("no accessor result reaches a mutating call", async () => {
    expect(await writes()).toEqual([]);
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
