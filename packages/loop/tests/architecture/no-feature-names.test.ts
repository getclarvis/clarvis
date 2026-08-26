/**
 * The engine must not name host-composed features in code or in prose.
 *
 * @remarks Memory sits *above* the engine and composes it: the loop reaches it
 * nowhere, and the kernel is what constructs the capability and injects it. This
 * scans comments as well as code, and that is the point. When memory moved out,
 * every import went with it in one commit — and a dozen TSDoc mentions stayed
 * behind, including one that documented a request parameter the engine had just
 * stopped declaring. Prose that names a feature the engine cannot see is how the
 * coupling grows back: someone reads "e.g. the memory seed", concludes the
 * engine knows what memory is, and adds the import that makes it true.
 *
 * The direct analogue is `packages/paths/tests/architecture/invariant.test.ts`, which scans
 * every package for `".clarvis"` because the duplicated literal had already
 * drifted into three defects.
 *
 * Planning follows the same boundary, with one narrower scan: only `src/` is
 * forbidden, because generic capability tests legitimately use a `plans` slot
 * as opaque fixture data. Production code has no such reason to name it.
 *
 * **`@clarvis/workflows` is deliberately not covered by the package-name scan.**
 * The engine publishes `@clarvis/loop/workflows` as a named adapter entry — that
 * is the sanctioned seam for workflow implementations. Its grant and spawn
 * semantics, however, are capability declarations and must not be duplicated in
 * the engine runtime. See `specs/engine/capability-composition.md`.
 *
 * **Scope is `src/` and `tests/`, not `README.md`.** Source and tests are what
 * grow back into code. The one test exception is the architecture audit that
 * starts at memory's public capability and proves its static closure does not
 * load any loop-optional package; naming the external entry is the invariant it
 * exercises. The README deliberately names both packages that sit above the
 * engine, because telling an integrator where the boundary is and how a
 * capability is injected is the rule being documented, not a breach of it.
 */
import { describe, expect, it } from "../bun-test.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(PKG, "src");
const TESTS = join(PKG, "tests");

/** Dedicated cross-package boundary audit that must name the external entry it walks. */
const MEMORY_TEST_EXCEPTIONS = new Set(["tests/architecture/optional-package-loading.test.ts"]);

/** Memory prose mentions. Case-insensitive, on a word boundary. */
const MEMORY_WORD = /\bmemor(y|ies)\b/i;

/** Code that names memory vocabulary without a sentence around it. */
const MEMORY_IDENTIFIER = /@clarvis\/memory|\bMEMORY_|\bMemory[A-Z]/;

/** Planning prose and identifiers, excluding unrelated words such as explanation. */
const PLANNING_WORD = /\bplan(?:s|ning)?\b/i;
const PLANNING_IDENTIFIER =
  /@clarvis\/plan|\bPLAN_|(?:^|[^A-Za-z])Plan[A-Z]|[a-z]Plan[A-Z]|\bplans[A-Z]/;

/**
 * The English senses of the word, which name no feature at all.
 *
 * @remarks Filtered before anything is reported, rather than allowlisted, because
 * these are not exceptions to the rule — they are a different word. `Memory` in
 * `createMemoryTraceStore` is `@clarvis/trace`'s `Map`-backed store
 * (`packages/trace/src/testing.ts`), `process.memoryUsage()` is Node's, and
 * "in-memory" is RAM. The collision is exactly why a hand-run grep for this
 * feature is so noisy, and why the rule needed to be a test.
 */
const ENGLISH_SENSE = /in-memory|in memory\b|InMemory|MemoryTraceStore|memoryUsage|memory of /i;

/** Every `.ts` file under `dir`, recursively. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...sources(abs));
    else if (abs.endsWith(".ts")) out.push(abs);
  }
  return out;
}

/** `<path>:<line>` for every line naming the feature. */
function memoryMentions(): string[] {
  const found: string[] = [];
  for (const file of [...sources(SRC), ...sources(TESTS)]) {
    const rel = relative(PKG, file).split("\\").join("/");
    // This file is the rule; it necessarily spells what it forbids.
    if (rel.endsWith("no-feature-names.test.ts")) continue;
    if (MEMORY_TEST_EXCEPTIONS.has(rel)) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (ENGLISH_SENSE.test(line)) return;
        if (MEMORY_WORD.test(line) || MEMORY_IDENTIFIER.test(line)) {
          found.push(`${rel}:${String(i + 1)}`);
        }
      });
  }
  return found;
}

/** `<path>:<line>` for every production line naming planning as a feature. */
function planningMentions(): string[] {
  const found: string[] = [];
  for (const file of sources(SRC)) {
    const rel = relative(PKG, file).split("\\").join("/");
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (PLANNING_WORD.test(line) || PLANNING_IDENTIFIER.test(line)) {
          found.push(`${rel}:${String(i + 1)}`);
        }
      });
  }
  return found;
}

describe("the engine does not name @clarvis/memory", () => {
  it("scans a non-trivial number of files, so a green run means something", () => {
    expect(sources(SRC).length + sources(TESTS).length).toBeGreaterThan(250);
  });

  it("names the feature nowhere outside its dedicated cross-package boundary audit", () => {
    expect(memoryMentions()).toEqual([]);
  });
});

describe("the engine does not name @clarvis/plan", () => {
  it("declares no package dependency on the feature", () => {
    const manifest = readFileSync(join(PKG, "package.json"), "utf8");
    expect(manifest).not.toContain('"@clarvis/plan"');
  });

  it("names the feature nowhere in production source", () => {
    expect(planningMentions()).toEqual([]);
  });
});
