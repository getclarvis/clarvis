#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  checkGateChain,
  checkPackageHarness,
  checkRootBuild,
  parseTestTable,
  PRELOAD_BASENAME,
} from "../lib/test-harness.ts";

const root = resolve(import.meta.dir, "../..");

/**
 * Packages that run no `bun test` at all, and so need neither the timeout flag nor the preload.
 *
 * @remarks
 * Kept in step with `TYPE_ONLY_PACKAGES` in `tooling/checks/coverage.ts`, which excuses the same
 * package's absent LCOV. A package added here that does run tests is reported rather than excused.
 */
const TYPE_ONLY = new Set(["protocol"]);

const packagesDir = join(root, "packages");
const names = (await readdir(packagesDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const failures = [];
let packageCount = 0;

for (const name of names) {
  const manifestPath = join(packagesDir, name, "package.json");
  if (!existsSync(manifestPath)) continue;
  packageCount += 1;

  const bunfigPath = join(packagesDir, name, "bunfig.toml");
  failures.push(
    ...checkPackageHarness({
      name,
      scripts: JSON.parse(readFileSync(manifestPath, "utf8")).scripts ?? {},
      bunfig: existsSync(bunfigPath) ? readFileSync(bunfigPath, "utf8") : undefined,
      typeOnly: TYPE_ONLY.has(name),
    }),
  );
}

const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
failures.push(...checkGateChain(rootManifest.scripts?.["check:pre-commit"]));
failures.push(...checkRootBuild(rootManifest.scripts));

const rootTable = parseTestTable(readFileSync(join(root, "bunfig.toml"), "utf8"));
if (!(rootTable.arrays.get("preload") ?? []).some((entry) => entry.endsWith(PRELOAD_BASENAME))) {
  failures.push(
    `root: bunfig \`[test] preload\` does not include \`${PRELOAD_BASENAME}\`, so a run by path from the repository root writes into the developer's real CLARVIS_HOME`,
  );
}

if (failures.length > 0) {
  console.error(`\ntest harness configuration (${String(failures.length)}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    "\nEach rule is one the gate silently depends on: a missing `--timeout` runs a suite on Bun's\n5 s default, a missing preload writes into a developer's real CLARVIS_HOME, and a bunfig\n`[test] timeout` or `coverageThreshold` is a setting Bun ignores or a floor the gate does not read.",
  );
  process.exitCode = 1;
} else {
  console.log(
    `test harness: ${String(packageCount)} packages, every \`bun test\` bounded, every bunfig preloaded and scoped, the root build complete, the gate sequential`,
  );
}
