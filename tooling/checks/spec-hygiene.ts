#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import {
  countLines,
  extractDocumentLinks,
  extractLineCitations,
  findDangerousCharacters,
  headingSlugs,
  resolveLink,
  resolveLineCitation,
} from "../lib/spec-hygiene.ts";

const root = resolve(import.meta.dir, "../..");

const tracked = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .filter((file) => !file.includes("/dist/") && !file.includes("node_modules/"))
  .filter((file) => existsSync(resolve(root, file)))
  .filter((file) => !lstatSync(resolve(root, file)).isSymbolicLink());

/**
 * This checker's own test, whose fixtures must contain the failures it detects.
 *
 * A test that asserts a dead link is reported has to hold a dead link, so scanning it would make the
 * check permanently red. Named here rather than excluded by directory: every other file under
 * `tooling/tests/` is scanned.
 */
const SELF_TEST = "tooling/tests/unit/spec-hygiene.test.ts";

const isMarkdown = (file) => file.endsWith(".md");
const isSource = (file) => /\.(?:ts|tsx|mjs|cjs|js|jsx)$/.test(file);

const contents = new Map();
const read = (file) => {
  const cached = contents.get(file);
  if (cached !== undefined) return cached;
  const text = readFileSync(resolve(root, file), "utf8");
  contents.set(file, text);
  return text;
};

const anchors = new Map();
const lineCounts = new Map();
const tree = {
  exists: (file) => existsSync(resolve(root, file)),
  join: (from, relative) => posix.normalize(posix.join(posix.dirname(from), relative)),
  anchorsOf: (file) => {
    const cached = anchors.get(file);
    if (cached !== undefined) return cached;
    const slugs = headingSlugs(read(file));
    anchors.set(file, slugs);
    return slugs;
  },
  lineCountOf: (file) => {
    const cached = lineCounts.get(file);
    if (cached !== undefined) return cached;
    const target = resolve(root, file);
    if (!existsSync(target) || !lstatSync(target).isFile()) return undefined;
    const count = countLines(read(file));
    lineCounts.set(file, count);
    return count;
  },
};

const dangerous = [];
const dead = [];
const invalidCitations = [];

for (const file of tracked) {
  const markdown = isMarkdown(file);
  if (!markdown && !isSource(file)) continue;

  const text = read(file);

  for (const finding of findDangerousCharacters(text, { allowInvisible: !markdown })) {
    dangerous.push(`${file}:${String(finding.line)}:${String(finding.column)} — ${finding.label}`);
  }

  if (file === SELF_TEST) continue;

  for (const link of extractDocumentLinks(text, file)) {
    const failure = resolveLink(link, file, tree);
    if (failure !== undefined) dead.push(failure);
  }
  for (const citation of extractLineCitations(text)) {
    invalidCitations.push(...resolveLineCitation(citation, file, tree));
  }
}

const report = (title, failures, remedy) => {
  if (failures.length === 0) return false;
  console.error(`\n${title} (${String(failures.length)}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(remedy);
  return true;
};

const failedCharacters = report(
  "literal dangerous characters",
  dangerous,
  "\nWrite the codepoint (`U+0000`) instead of the character. A literal NUL makes git treat the file\nas binary, which hides it from ripgrep and from line-level diffs.",
);

const failedLinks = report(
  "documentation links that resolve to nothing",
  dead,
  "\nRepoint each link at the document that now holds the content. Repair by symbol, never by a\nmechanical line or path delta.",
);

const failedCitations = report(
  "source citations with invalid line bounds",
  invalidCitations,
  "\nRepair each citation by locating the owning symbol or assertion in the target file. Do not\napply a blind line-number offset.",
);

if (failedCharacters || failedLinks || failedCitations) process.exitCode = 1;
else
  console.log(
    `spec hygiene: ${String(tracked.length)} tracked files, no dangerous characters, every documentation link resolves, every existing source citation is in bounds`,
  );
