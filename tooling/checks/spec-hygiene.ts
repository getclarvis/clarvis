#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import {
  extractCalendarDates,
  extractDocumentLinks,
  extractLineQualifiedReferences,
  extractRepositoryFileReferences,
  extractSourceSizeReferences,
  findDangerousCharacters,
  headingSlugs,
  resolveLink,
  resolveRepositoryFileReference,
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
const trackedSpecs = new Set(
  execFileSync("git", ["ls-files", "-z", "--cached", "specs/*.md", "specs/**/*.md"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean),
);

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
};

const dangerous = [];
const dead = [];
const lineQualified = [];
const missingReferences = [];
const datedSpecs = [];
const sourceSizeClaims = [];

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
  if (markdown || (!file.includes("/tests/") && !file.startsWith("tooling/tests/"))) {
    for (const reference of extractLineQualifiedReferences(text)) {
      lineQualified.push(
        `${file}:${String(reference.line)} → ${reference.raw} (use the file path and a named symbol or test)`,
      );
    }
  }
  if (markdown && !file.startsWith("specs/proposals/")) {
    for (const reference of extractRepositoryFileReferences(text)) {
      const failure = resolveRepositoryFileReference(reference, file, tree);
      if (failure !== undefined) missingReferences.push(failure);
    }
  }
  if (trackedSpecs.has(file)) {
    for (const finding of extractCalendarDates(text)) {
      datedSpecs.push(`${file}:${String(finding.line)} → ${finding.raw}`);
    }
    for (const finding of extractSourceSizeReferences(text)) {
      sourceSizeClaims.push(`${file}:${String(finding.line)} → ${finding.raw}`);
    }
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

const failedLineQualified = report(
  "line-qualified repository references",
  lineQualified,
  "\nRemove the line number. Cite the stable repository file and name the owning symbol, test, or\nsection in prose when the path alone is not precise enough.",
);

const failedReferences = report(
  "repository file references that resolve to nothing",
  missingReferences,
  "\nRepoint the reference at the current repository file. Use placeholders for illustrative paths\nthat are intentionally not part of this tree.",
);

const failedDatedSpecs = report(
  "calendar dates in tracked specifications",
  datedSpecs,
  "\nKeep specifications timeless. Put change chronology in CHANGELOG.md and use semantic\nplaceholders for date-shaped data examples.",
);

const failedSourceSizeClaims = report(
  "source-code line counts in tracked specifications",
  sourceSizeClaims,
  "\nRemove inventory-style source-size figures. Keep behavioral line limits and coverage ratios when\nthey are part of the contract.",
);

if (
  failedCharacters ||
  failedLinks ||
  failedLineQualified ||
  failedReferences ||
  failedDatedSpecs ||
  failedSourceSizeClaims
)
  process.exitCode = 1;
else
  console.log(
    `spec hygiene: ${String(tracked.length)} files, no dangerous characters, unstable line references, calendar dates, or source-size claims in tracked specs; every documentation link and explicit repository file reference resolves`,
  );
