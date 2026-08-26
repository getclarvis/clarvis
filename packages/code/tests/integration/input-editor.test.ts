import { expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { openTempDir } from "../helpers/tracked-temp.ts";
import { fuzzyFilter, fuzzyScore } from "../../src/core/fuzzy.ts";
import { createPromptHistory } from "../../src/core/prompt-history.ts";
import { createFilePromptHistory } from "../../src/adapters/file-prompt-history.ts";
import { MAX_PROMPT_HISTORY_ENTRY_CHARS } from "../../src/core/prompt-history.ts";

test("fuzzyFilter: empty term is identity", () => {
  expect(fuzzyFilter(["b", "a", "c"], "", (x) => x)).toEqual(["b", "a", "c"]);
});

test("fuzzyFilter: subsequence match, case-insensitive, non-matches dropped", () => {
  const items = ["src/App.tsx", "src/adapters/store.ts", "README.md"];
  const out = fuzzyFilter(items, "store", (x) => x);
  expect(out).toEqual(["src/adapters/store.ts"]);
  expect(fuzzyFilter(items, "APP", (x) => x)).toEqual(["src/App.tsx"]);
});

test("fuzzyFilter: ranks contiguous / boundary matches higher", () => {
  const items = ["a_b_config", "abc"];
  expect(fuzzyFilter(items, "abc", (x) => x)[0]).toBe("abc");
});

test("fuzzyScore: null when not a subsequence", () => {
  expect(fuzzyScore("hello", "xyz")).toBeNull();
  expect(fuzzyScore("hello", "hlo")).not.toBeNull();
});

test("promptHistory: push then prev/next walks the ring and restores the live draft", () => {
  const h = createPromptHistory(200, null);
  h.push("first");
  h.push("second");
  expect(h.prev("draft")).toBe("second");
  expect(h.prev("draft")).toBe("first");
  expect(h.prev("draft")).toBe("first");
  expect(h.next()).toBe("second");
  expect(h.next()).toBe("draft");
  expect(h.next()).toBeUndefined();
});

test("promptHistory: empty prev is undefined; consecutive dupes collapse", () => {
  const h = createPromptHistory(200, null);
  expect(h.prev("x")).toBeUndefined();
  h.push("same");
  h.push("same");
  expect(h.size()).toBe(1);
});

test("promptHistory: seed + limit", () => {
  const h = createPromptHistory(2, null);
  h.seed(["a", "b", "c"]);
  expect(h.size()).toBe(2);
  expect(h.prev("")).toBe("c");
  expect(h.prev("")).toBe("b");
});

function historyFile(): string {
  return join(openTempDir("clarvis-prompt-history-"), ".clarvis", "prompt-history");
}

test("promptHistory: pushes persist and a fresh history reloads them in order", async () => {
  const file = historyFile();
  const first = createFilePromptHistory(200, file);
  first.push("one");
  first.push("two\nwith a second line");
  first.push("three");
  await first.flush();

  const restarted = createFilePromptHistory(200, file);
  expect(restarted.size()).toBe(3);
  expect(restarted.prev("")).toBe("three");
  expect(restarted.prev("")).toBe("two\nwith a second line");
  expect(restarted.prev("")).toBe("one");
});

test("promptHistory: the cap applies on reload and the file is compacted to it", async () => {
  const file = historyFile();
  const writer = createFilePromptHistory(200, file);
  for (const t of ["a", "b", "c", "d", "e"]) writer.push(t);
  await writer.flush();

  const capped = createFilePromptHistory(2, file);
  expect(capped.size()).toBe(2);
  expect(capped.prev("")).toBe("e");
  expect(capped.prev("")).toBe("d");
  await capped.flush();
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  expect(lines).toEqual(['"d"', '"e"']);
});

test("promptHistory: a corrupt line is skipped, the rest of the file still loads", async () => {
  const file = historyFile();
  const writer = createFilePromptHistory(200, file);
  writer.push("keep me");
  await writer.flush();
  writeFileSync(file, readFileSync(file, "utf8") + "{not json\n" + '"and me"\n');

  const h = createFilePromptHistory(200, file);
  expect(h.size()).toBe(2);
  expect(h.prev("")).toBe("and me");
  expect(h.prev("")).toBe("keep me");
});

test("promptHistory: resume seeding skips prompts already loaded from the file", async () => {
  const file = historyFile();
  const typed = createFilePromptHistory(200, file);
  typed.push("p1");
  typed.push("p2");
  typed.push("p3");
  await typed.flush();

  const resumed = createFilePromptHistory(200, file);
  resumed.seed(["p1", "p2", "p3"]);
  resumed.seed(["p1", "p2", "p3"]);
  expect(resumed.size()).toBe(3);
  expect(resumed.prev("")).toBe("p3");
  expect(resumed.prev("")).toBe("p2");
  expect(resumed.prev("")).toBe("p1");
  expect(resumed.prev("")).toBe("p1");
});

test("promptHistory: seeding still recovers resumed prompts the file no longer has", async () => {
  const file = historyFile();
  const h = createFilePromptHistory(200, file);
  h.push("kept");
  await h.flush();
  h.seed(["lost to a trim or deleted file", "kept"]);
  expect(h.size()).toBe(2);
  expect(h.prev("")).toBe("lost to a trim or deleted file");
  expect(h.prev("")).toBe("kept");
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  expect(lines).toEqual(['"kept"']);
});

test("promptHistory: seeding (session resume) never writes to the file", () => {
  const file = historyFile();
  const h = createFilePromptHistory(200, file);
  h.seed(["from a resumed session"]);
  expect(h.size()).toBe(1);
  expect(existsSync(file)).toBe(false);
});

test("promptHistory: file null stays memory-only", () => {
  const h = createPromptHistory(200, null);
  h.push("never on disk");
  expect(h.size()).toBe(1);
});

test("promptHistory: push stays synchronous in memory while disk work is queued", async () => {
  const file = historyFile();
  const h = createFilePromptHistory(200, file);
  h.push("queued");
  expect(h.prev("")).toBe("queued");
  expect(existsSync(file)).toBe(false);
  await h.flush();
  expect(readFileSync(file, "utf8")).toBe('"queued"\n');
});

test("promptHistory: persistence failure is reported once and does not poison the queue", async () => {
  const file = historyFile();
  writeFileSync(dirname(file), "not a directory");
  const failures: string[] = [];
  const h = createFilePromptHistory(200, file, {
    onPersistenceError: ({ operation }) => failures.push(operation),
  });
  h.push("one");
  h.push("two");
  await h.flush();
  expect(h.size()).toBe(2);
  expect(h.persistenceDegraded()).toBe(true);
  expect(failures).toEqual(["append"]);
});

test("promptHistory: rejects one giant entry and bounds an adversarial limit", () => {
  const h = createPromptHistory(Number.MAX_SAFE_INTEGER, null);
  h.push("x".repeat(MAX_PROMPT_HISTORY_ENTRY_CHARS + 1));
  for (let index = 0; index < 1_100; index += 1) h.push(`entry-${index}`);
  expect(h.size()).toBe(1_000);
  expect(h.prev("")).toBe("entry-1099");
});

test("promptHistory: loads only the bounded tail of a sparse oversized file", async () => {
  const file = historyFile();
  await fs.mkdir(dirname(file), { recursive: true });
  const fd = openSync(file, "w");
  try {
    truncateSync(file, 64 * 1024 * 1024);
  } finally {
    closeSync(fd);
  }
  await fs.appendFile(file, '\n"tail entry"\n');

  const h = createFilePromptHistory(200, file);
  expect(h.size()).toBe(1);
  expect(h.prev("")).toBe("tail entry");
  await h.flush();
  expect(readFileSync(file, "utf8")).toBe('"tail entry"\n');
});
