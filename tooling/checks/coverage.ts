import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Minimum own-source coverage ratios enforced after every workspace suite.
 *
 * `@clarvis/memory` and `@clarvis/plan` ship a `src/testing.ts` that sits in
 * their own denominators — it is source, not a test file, so neither the LCOV
 * filter here nor their `coveragePathIgnorePatterns` excludes it. Both are
 * unusually well covered, so they lift the reported figure above the package's
 * real `src` coverage. Measured 2026-08-22:
 *
 * | package | reported        | excluding `testing.ts` | floor       |
 * | ------- | --------------- | ---------------------- | ----------- |
 * | memory  | 95.55% / 96.28% | 94.76% / 95.80%        | 90% / 95%   |
 * | plan    | 98.65% / 99.00% | 98.55% / 98.85%        | 95% / 97%   |
 *
 * So the inflation is real (0.79 and 0.48 points for `memory`) and immaterial:
 * every floor holds on either denominator, which is the question that was open.
 * Excluding it was rejected on that evidence — a `testing.ts` a package ships is
 * consumed by other packages' suites, so it is production surface for them, and
 * removing it would stop measuring code that really does run.
 */
const PACKAGE_THRESHOLDS = {
  capability: { functions: 1, lines: 1 },
  code: { functions: 0.93, lines: 0.96 },
  hooks: { functions: 1, lines: 1 },
  kernel: { functions: 0.94, lines: 0.97 },
  llm: { functions: 1, lines: 1 },
  loop: { functions: 0.96, lines: 0.98 },
  "mcp-client": { functions: 0.9, lines: 0.98 },
  memory: { functions: 0.9, lines: 0.95 },
  paths: { functions: 1, lines: 1 },
  plan: { functions: 0.95, lines: 0.97 },
  protocol: { functions: 1, lines: 1 },
  server: { functions: 0.9, lines: 0.96 },
  skills: { functions: 1, lines: 1 },
  supervision: { functions: 0.98, lines: 1 },
  tasks: { functions: 0.95, lines: 0.98 },
  tools: { functions: 0.98, lines: 0.98 },
  trace: { functions: 0.98, lines: 0.97 },
  workflows: { functions: 1, lines: 1 },
};

/**
 * Packages whose public surface is type-only and therefore emits no LCOV
 * counters. Being on this set excuses an absent/empty LCOV report, but every
 * source module is still scanned by {@link looksExecutionFree}; a runtime export
 * fails even when a stale report happens to mention that module.
 */
const TYPE_ONLY_PACKAGES = new Set(["protocol"]);

// A module that NO test file imports is absent from LCOV entirely rather than
// present at 0% - it contributes to neither numerator nor denominator, so a
// package can hold a 99% floor over a denominator missing a quarter of its own
// source and nothing reports it. Every src file must therefore appear as an
// `SF:` record, and anything that legitimately cannot must be named here.
//
// Three reasons are legitimate and permanent: a type-only module (nothing is
// emitted, so there is nothing to count), a pure re-export barrel (every
// statement is an `export ... from`), and an executable entry point a test
// cannot import without starting the process it boots.
//
// A fourth was not, and no entry claims it any more. Modules marked
// GRANDFATHERED were real, executable and untested; they were recorded rather
// than fixed so this check could land at all, and every one of them has since
// been closed by writing the missing test and deleting its entry - the last,
// loop's `src/settings/marketplace-schema.ts`, on 2026-08-22. So every entry
// below is one of the three permanent reasons. Do not open a fourth: an
// untested module belongs in a test, not here.
const NO_COUNTER_ALLOWLIST = {
  capability: [
    // Type-only: declares interfaces/aliases and emits nothing at runtime.
    "src/agents-port.ts",
    "src/api.ts",
    "src/compaction-anchor.ts",
    "src/convergence-guards.ts",
    "src/loop-contract.ts",
    "src/output-budget.ts",
    "src/ports.ts",
    "src/usage.ts",
  ],
  code: [
    // Type-only.
    "src/adapters/run-types.ts",
    "src/boot-shell.ts",
    "src/core/run-types.ts",
    "src/core/transcript/types.ts",
    "src/views/config/providers/context.ts",
    // Executable entry points plus the complete TUI runtime.
    // Importing any of them from a test starts process/application lifecycle work.
    //
    // `src/index.tsx` is the thin renderer entry and `src/runtime.tsx` is the
    // complete interactive/headless boot it imports after first input paint.
    // Importing either still starts application lifecycle work; their end-to-end
    // cover is the PTY-driven artifact smoke. Splitting the entry keeps heavy
    // code out of first paint but does not make either module safe to import into
    // the in-process coverage runner.
    "src/cli.ts",
    "src/index.tsx",
    "src/runtime.tsx",
  ],
  hooks: [],
  kernel: [
    // Type-only: internal subscription adapter and persistence contracts.
    "src/subscriptions/types.ts",
    // Type-only.
    "src/config/builtin-agents/types.ts",
    "src/connection-health.ts",
    "src/ports/plugin-repository.ts",
    "src/ports/process-runner.ts",
    // Pure re-export barrel for the startup logger path.
    "src/logger.ts",
    // Executable entry point: the `clarvis-kernel` bin. Unlike the server's, this
    // one is a thin `serveFileKernelOverStdio` wrapper plus two failure writes,
    // so the untested surface is small and the decision below does not apply.
    "src/bin.ts",
  ],
  loop: [
    // Pure re-export barrels: every statement is an `export ... from`, which
    // emits no counters of its own.
    "src/host.ts",
    "src/lib.ts",
    "src/workflows.ts",
    "src/workspace.ts",
  ],
  memory: [
    // Type-only.
    "src/job-contract.ts",
    "src/memory-contract.ts",
    "src/run-contract.ts",
    "src/types.ts",
  ],
  server: [
    // Executable entry point: the `clarvis-server` bin, where the CLI
    // argument parsing and bind-address policy live. Its behaviour -
    // including the fail-closed bind-address gate AGENTS.md names as
    // inviolable - is exercised by real subprocess tests in
    // tests/bin-bind-gate.test.ts, asserting on the externally observable
    // exit code and stderr message. Bun's coverage instrumentation only sees
    // code running inside the `bun test` process itself, so a subprocess
    // contributes no counters here no matter how thoroughly it is tested.
    // Measured: importing the module in-process (mocking `process.exit` to
    // stop it where a real exit would) does add it to the LCOV report, but
    // `bun test`'s module cache is shared across every file in one run (no
    // `--isolate` here), so only one of the file's many mutually exclusive
    // early-return branches can ever execute per suite run - at most ~84% of
    // its lines even in the best single-branch case, against a package line
    // floor at 96% with under 1 point of headroom. Closing this needs either
    // splitting the gate into a directly importable, unit-testable function
    // (the shape `isPrivateBind`/`isPrivateLanBind` already use), or a
    // verified way to run more than one scenario against this file in one
    // coverage run.
    "src/bin.ts",
  ],
  skills: [
    // Type-only.
    "src/types.ts",
  ],
  supervision: [
    // Pure re-export barrel.
    "src/index.ts",
  ],
  tasks: [
    // Type-only domain and narrow port contracts.
    "src/provider.ts",
    "src/server-port.ts",
  ],
  tools: [
    // Type-only.
    "src/guard/dialect.ts",
    "src/guard/types.ts",
    "src/sandbox-entry.ts",
    "src/tools/types.ts",
    // Pure re-export barrels for the narrow shell and monitor subpaths.
    "src/monitor-entry.ts",
    "src/shell-entry.ts",
  ],
  trace: [
    // Type-only.
    "src/trace-handle.ts",
  ],
  workflows: [
    // Type-only.
    "src/types.ts",
    // Pure re-export barrel.
    "src/index.ts",
  ],
};

/** Every `.ts`/`.tsx` module under a package's `src/`, as package-relative paths. */
async function listSourceModules(packageDirectory) {
  const found = [];
  const walk = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (/\.tsx?$/u.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        found.push(path.relative(packageDirectory, child));
      }
    }
  };
  await walk(path.join(packageDirectory, "src"));
  return found.sort();
}

/** Reads a numeric LCOV summary field from one record. */
function field(record, name) {
  const line = record.find((entry) => entry.startsWith(`${name}:`));
  return line === undefined ? 0 : Number(line.slice(name.length + 1));
}

/** Aggregates only src files belonging to the package that produced the report. */
export async function readOwnSourceCoverage(packageName, root = repositoryRoot) {
  const packageDirectory = path.join(root, "packages", packageName);
  const reportPath = path.join(packageDirectory, "coverage", "lcov.info");
  let report;
  try {
    report = await readFile(reportPath, "utf8");
  } catch (error) {
    const missing =
      error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
    if (!missing || !TYPE_ONLY_PACKAGES.has(packageName)) throw error;
    // Missing coverage is legitimate; a missing package/source tree is not.
    await readdir(path.join(packageDirectory, "src"));
    return { functions: 1, lines: 1, measured: new Set() };
  }
  const totals = { functionsFound: 0, functionsHit: 0, linesFound: 0, linesHit: 0 };
  const measured = new Set();

  for (const rawRecord of report.split("end_of_record")) {
    const record = rawRecord.split(/\r?\n/u).filter(Boolean);
    const sourceLine = record.find((entry) => entry.startsWith("SF:"));
    if (sourceLine === undefined) continue;

    const sourcePath = path.resolve(packageDirectory, sourceLine.slice(3));
    const relativePath = path.relative(packageDirectory, sourcePath);
    if (relativePath === "src" || relativePath.startsWith(`src${path.sep}`)) {
      measured.add(relativePath);
      totals.functionsFound += field(record, "FNF");
      totals.functionsHit += field(record, "FNH");
      totals.linesFound += field(record, "LF");
      totals.linesHit += field(record, "LH");
    }
  }

  if (totals.linesFound === 0) {
    if (TYPE_ONLY_PACKAGES.has(packageName)) {
      return { functions: 1, lines: 1, measured };
    }
    throw new Error(`${packageName}: LCOV report contains no own-source line data`);
  }

  return {
    functions: totals.functionsFound === 0 ? 1 : totals.functionsHit / totals.functionsFound,
    lines: totals.linesHit / totals.linesFound,
    measured,
  };
}

/**
 * Whether a TypeScript source file could not possibly emit any executable
 * JavaScript: strip comments, then every remaining `export` is a `type`/
 * `interface` declaration or an `export type` re-export.
 *
 * @remarks Exists only for {@link findUnmeasuredSources}'s
 * {@link TYPE_ONLY_PACKAGES} path. Bun's LCOV report never mentions a module
 * nothing ever loaded, so for a file with no `SF:` record at all it cannot
 * tell "genuinely emits no counters" apart from "has real code nothing has
 * ever imported" - the two are indistinguishable from the report alone, and
 * only the source text can tell them apart. This is a heuristic over syntax,
 * not a type checker: it trusts that a package this narrow declares itself
 * `type-only` honestly, and only catches the shapes an added runtime export
 * actually takes (`export const`/`function`/`class`/`enum`/`default`, or a
 * value re-export via `export * from`/`export { x } from`).
 */
function looksExecutionFree(source) {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:\\])\/\/.*$/gmu, "$1");
  const withoutTypeExports = withoutComments.replace(/^[ \t]*export\s+type\b.*$/gmu, "");
  const executableExport =
    /^[ \t]*export\s+(default\b|(?:async\s+|abstract\s+)*(?:const(?!\s+enum\b)|let\b|var\b|function\b|class\b|enum\b)|\*\s*(?:as\s+\S+\s+)?from\b|\{[^}]*\}\s*(from\b|;))/mu;
  return !executableExport.test(withoutTypeExports);
}

/**
 * Names the package's src modules that produced no LCOV record at all and are
 * not on {@link NO_COUNTER_ALLOWLIST}. Such a module is invisible to the ratios
 * above rather than counted as uncovered, so this is what stops a package
 * holding its floor over an incomplete denominator.
 *
 * @remarks Every module in a {@link TYPE_ONLY_PACKAGES} member is scanned even
 * when a stale LCOV report mentions it. A runtime export violates the package's
 * declaration independently of whether coverage happened to execute it.
 */
export async function findUnmeasuredSources(packageName, measured, root = repositoryRoot) {
  const packageDirectory = path.join(root, "packages", packageName);
  const modules = await listSourceModules(packageDirectory);
  const allowed = new Set(
    (NO_COUNTER_ALLOWLIST[packageName] ?? []).map((entry) => entry.split("/").join(path.sep)),
  );
  const typeOnlyPackage = TYPE_ONLY_PACKAGES.has(packageName);

  const unmeasured = [];
  const runtimeExports = [];
  for (const file of modules) {
    if (typeOnlyPackage) {
      const source = await readFile(path.join(packageDirectory, file), "utf8");
      if (!looksExecutionFree(source)) runtimeExports.push(file);
      continue;
    }
    if (measured.has(file) || allowed.has(file)) continue;
    unmeasured.push(file);
  }

  return {
    unmeasured,
    runtimeExports,
    stale: [...allowed].filter((file) => measured.has(file) || !modules.includes(file)),
  };
}

/**
 * Report whether a package's LCOV predates its own sources.
 *
 * @param packageName - the workspace to inspect.
 * @param root - the repository root.
 * @returns the newest `src` file modified after the report, or `null` when the
 *   report is current, absent, or the package emits none.
 * @remarks The script reads whatever LCOV happens to be on disk, and every
 *   number it prints is only as fresh as that file. In the gate this cannot bite
 *   — `test:coverage` runs immediately before — but run on its own it silently
 *   reports the last run's figures, and a source file added since then shows up
 *   as "produced no coverage record at all" when the truth is that nothing has
 *   measured it yet. Both failure modes read as findings about the code rather
 *   than about the report's age, which is exactly the confusion worth naming.
 *
 *   A type-only package is exempt: its `test:coverage` is a `tsc` invocation that
 *   writes no LCOV at all, so whatever report exists can never be refreshed and
 *   the warning would be permanent noise on every run. Its figures are a
 *   sentinel rather than a measurement, and `looksExecutionFree` is what actually
 *   guards them.
 */
export async function staleReport(packageName, root = repositoryRoot) {
  if (TYPE_ONLY_PACKAGES.has(packageName)) return null;
  const packageDirectory = path.join(root, "packages", packageName);
  let reportedAt;
  try {
    reportedAt = (await stat(path.join(packageDirectory, "coverage", "lcov.info"))).mtimeMs;
  } catch {
    return null;
  }
  let newest = null;
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) {
        const { mtimeMs } = await stat(child);
        if (mtimeMs > reportedAt && (newest === null || mtimeMs > newest.mtimeMs)) {
          newest = { file: path.relative(packageDirectory, child), mtimeMs };
        }
      }
    }
  };
  try {
    await walk(path.join(packageDirectory, "src"));
  } catch {
    return null;
  }
  return newest === null ? null : newest.file;
}

/** Formats a ratio as a two-decimal percentage. */
function percentage(value) {
  return `${(value * 100).toFixed(2)}%`;
}

/** Check every workspace's own-source coverage and complete module inventory. */
export async function checkCoverage(root = repositoryRoot) {
  const failures = [];

  for (const [packageName, thresholds] of Object.entries(PACKAGE_THRESHOLDS)) {
    const coverage = await readOwnSourceCoverage(packageName, root);
    const functionStatus = coverage.functions >= thresholds.functions ? "pass" : "FAIL";
    const lineStatus = coverage.lines >= thresholds.lines ? "pass" : "FAIL";

    console.log(
      `${packageName.padEnd(10)} functions ${percentage(coverage.functions)} ` +
        `(min ${percentage(thresholds.functions)}) ${functionStatus}; ` +
        `lines ${percentage(coverage.lines)} (min ${percentage(thresholds.lines)}) ${lineStatus}`,
    );

    if (coverage.functions < thresholds.functions) {
      failures.push(
        `${packageName} function coverage ${percentage(coverage.functions)} is below ${percentage(thresholds.functions)}`,
      );
    }
    if (coverage.lines < thresholds.lines) {
      failures.push(
        `${packageName} line coverage ${percentage(coverage.lines)} is below ${percentage(thresholds.lines)}`,
      );
    }

    const { unmeasured, runtimeExports, stale } = await findUnmeasuredSources(
      packageName,
      coverage.measured ?? new Set(),
      root,
    );
    if (unmeasured.length > 0) {
      failures.push(
        `${packageName}: ${unmeasured.length} src module(s) produced no coverage record at all, ` +
          `so the ratios above were computed without them: ${unmeasured.join(", ")}. ` +
          "Import each from a test, or add it to NO_COUNTER_ALLOWLIST in tooling/checks/coverage.ts " +
          "with the reason.",
      );
    }
    if (runtimeExports.length > 0) {
      failures.push(
        `${packageName}: declared type-only but ${runtimeExports.length} src module(s) contain ` +
          `runtime exports: ${runtimeExports.join(", ")}. Remove the runtime values or stop ` +
          "classifying the package as type-only.",
      );
    }
    // Not a failure: a stale entry is someone having closed a gap or deleted a
    // file, and breaking their build for it would be a poor thank-you.
    const staleEntries = stale as string[];
    if (staleEntries.length > 0) {
      console.log(
        `${packageName.padEnd(10)} NO_COUNTER_ALLOWLIST entries no longer needed: ${staleEntries.join(", ")}`,
      );
    }

    // Also not a failure: a report can legitimately be older than a comment-only
    // edit. But saying so turns "this module has no coverage record" from a claim
    // about the code into what it usually is — a claim about the report's age.
    const outdatedBy = await staleReport(packageName, root);
    if (outdatedBy !== null) {
      console.log(
        `${packageName.padEnd(10)} coverage report predates ${outdatedBy}; ` +
          `re-run \`bun --filter @clarvis/${packageName} test:coverage\` before citing these figures`,
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "Own-source coverage checks did not pass");
  }

  console.log("All own-source coverage thresholds passed, over every src module.");
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && path.resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  await checkCoverage();
}
