#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  checkTestDeterminismBaseline,
  findTestDeterminismOccurrences,
  normalizeTestPath,
  packageOwnerOf,
  type TestDeterminismBaseline,
  type TestDeterminismOccurrence,
  type TestDeterminismSource,
} from "../lib/test-determinism.ts";

const root = resolve(import.meta.dir, "../..");
const baselinePath = join(root, "tooling", "test-runtime", "test-determinism-baseline.json");
const TEST_LEVELS = new Set([
  "architecture",
  "component",
  "contract",
  "e2e",
  "integration",
  "unit",
]);
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

async function testFilesUnder(directory: string, output: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) await testFilesUnder(child, output);
    else if (entry.isFile() && TEST_FILE.test(entry.name)) output.push(child);
  }
}

async function repositoryTestFiles(): Promise<string[]> {
  const files: string[] = [];
  const packages = await readdir(join(root, "packages"), { withFileTypes: true });
  for (const packageEntry of packages) {
    if (!packageEntry.isDirectory()) continue;
    const testsRoot = join(root, "packages", packageEntry.name, "tests");
    for (const level of TEST_LEVELS) await testFilesUnder(join(testsRoot, level), files);
  }
  for (const level of TEST_LEVELS)
    await testFilesUnder(join(root, "tooling", "tests", level), files);
  return files.sort();
}

async function census(): Promise<TestDeterminismOccurrence[]> {
  const files = await repositoryTestFiles();
  const sources: TestDeterminismSource[] = await Promise.all(
    files.map(async (file) => ({
      file: normalizeTestPath(relative(root, file)),
      source: await readFile(file, "utf8"),
    })),
  );
  return findTestDeterminismOccurrences(sources);
}

function readBaseline(): TestDeterminismBaseline {
  if (!existsSync(baselinePath)) return { version: 1, entries: [] };
  const parsed: unknown = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (!parsed || typeof parsed !== "object")
    throw new Error("test determinism baseline must be an object");
  return parsed as TestDeterminismBaseline;
}

function stableOccurrences(occurrences: readonly TestDeterminismOccurrence[]) {
  return [...occurrences]
    .sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.mechanism.localeCompare(right.mechanism) ||
        left.identity.localeCompare(right.identity) ||
        left.line - right.line ||
        left.column - right.column,
    )
    .map((occurrence) => ({
      file: occurrence.file,
      line: occurrence.line,
      column: occurrence.column,
      mechanism: occurrence.mechanism,
      identity: occurrence.identity,
      package_owner: packageOwnerOf(occurrence.file),
      classification: occurrence.classification,
      reason: occurrence.reason,
    }));
}

function annotateBaseline(
  occurrences: readonly TestDeterminismOccurrence[],
  baseline: TestDeterminismBaseline,
): TestDeterminismOccurrence[] {
  const entries = new Map(
    baseline.entries.map((entry) => [
      `${normalizeTestPath(entry.file)}|${entry.mechanism}|${entry.identity}`,
      entry,
    ]),
  );
  return occurrences.map((occurrence) => {
    const entry = entries.get(`${occurrence.file}|${occurrence.mechanism}|${occurrence.identity}`);
    return entry
      ? { ...occurrence, classification: entry.classification, reason: entry.reason }
      : occurrence;
  });
}

function usage(): never {
  console.error("usage: bun tooling/checks/test-determinism.ts [--report|--check] [--json]");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const report = args.has("--report");
  const check = args.has("--check") || !report;
  const json = args.has("--json");
  if ([...args].some((arg) => !["--report", "--check", "--json"].includes(arg))) usage();
  if (report && args.has("--check")) usage();

  const occurrences = await census();
  const baseline = readBaseline();
  const result = check ? checkTestDeterminismBaseline(occurrences, baseline) : undefined;
  const displayedOccurrences = annotateBaseline(occurrences, baseline);
  if (json) {
    const payload = {
      version: 1,
      mode: report ? "report" : "check",
      occurrences: stableOccurrences(displayedOccurrences),
      baseline_entries: baseline.entries,
      failures: result?.failures ?? [],
      counts: Object.fromEntries(
        [...new Set(occurrences.map((occurrence) => occurrence.mechanism))]
          .sort()
          .map((mechanism) => [
            mechanism,
            occurrences.filter((occurrence) => occurrence.mechanism === mechanism).length,
          ]),
      ),
    };
    console.log(JSON.stringify(payload, null, 2));
  } else if (report) {
    console.log(`test determinism census: ${String(occurrences.length)} occurrence(s)`);
    for (const occurrence of stableOccurrences(displayedOccurrences)) {
      console.log(
        `${occurrence.file}:${String(occurrence.line)}:${String(occurrence.column)} ${occurrence.mechanism} ${occurrence.classification} ${occurrence.identity} (${occurrence.reason})`,
      );
    }
  } else if (result && result.failures.length > 0) {
    console.error(`test determinism check (${String(result.failures.length)}):`);
    for (const failure of result.failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(
      `test determinism: ${String(occurrences.length)} occurrence(s), baseline consistent`,
    );
  }
}

if (import.meta.main) await main();

export { census, main, repositoryTestFiles };
