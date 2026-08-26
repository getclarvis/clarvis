#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzePackageGraph, checkDocument, renderMarkdown } from "../lib/package-graph.ts";

const root = resolve(import.meta.dir, "../..");
const args = new Set(process.argv.slice(2));
const report = analyzePackageGraph(root);
const failures = [...report.errors];

if (args.has("--check-doc")) {
  failures.push(
    ...checkDocument(
      report,
      readFileSync(resolve(root, "specs/package-coupling-analysis.md"), "utf8"),
    ),
  );
}

if (args.has("--json")) console.log(JSON.stringify(report, null, 2));
else console.log(renderMarkdown(report));

if (failures.length > 0) {
  console.error(
    "\npackage graph violations:\n" + failures.map((failure) => `- ${failure}`).join("\n"),
  );
  process.exitCode = 1;
}
