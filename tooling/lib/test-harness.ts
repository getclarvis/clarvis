import { testFileLevel } from "./source-policy.ts";

/**
 * The per-test timeout every `bun test` invocation must carry on its command line.
 *
 * @remarks
 * Bun parses `[test] timeout` in a `bunfig.toml` and then ignores it — from the repository root and
 * from a package's own bunfig alike — so a value declared there is not a setting, it is a comment
 * that reads like one. A package whose script omits the flag silently runs on Bun's 5 s default.
 */
const REQUIRED_TIMEOUT = "--timeout 60000";

/**
 * The preload that redirects the Clarvis global root at a throwaway directory for a test process.
 *
 * @remarks
 * Bun resolves `bunfig.toml` from the *cwd* and does not merge a package's with the root's, so every
 * bunfig that can be the nearest one to a test run needs its own copy of this line.
 */
export const PRELOAD_BASENAME = "clarvis-home-preload.ts";

/**
 * Keys a `bunfig.toml` must never declare under `[test]`, each with the reason.
 *
 * @remarks
 * `timeout` is parsed and ignored by Bun, so declaring it reads as a ceiling that is not in force.
 * `coverageThreshold` would move a floor out of `tooling/checks/coverage.ts`, whose summed LCOV
 * counters are the only numbers the gate trusts — Bun's own per-file average disagreed with them by
 * 2.6 points on one package.
 */
const FORBIDDEN_BUNFIG_KEYS = new Map([
  [
    "timeout",
    "Bun parses `[test] timeout` and ignores it; the value belongs on the `test` script as `--timeout`",
  ],
  [
    "coverageThreshold",
    "coverage floors live only in `tooling/checks/coverage.ts`, which sums LCOV counters rather than averaging per file",
  ],
]);

/**
 * The value every package `bunfig.toml` must give `coveragePathIgnorePatterns`.
 *
 * @remarks
 * Without it a package is charged for the workspace dependencies its tests load, so its ratio
 * measures somebody else's source.
 */
const REQUIRED_IGNORE_PATTERN = "../**";

const BUN_TEST_CALL = /\bbun\s+test\b[^&|]*/g;
const RUN_SCRIPT_CALL = /\bbun\s+run\s+([\w:.-]+)/g;

/**
 * Expand a package script into every `bun test` invocation it can reach.
 *
 * @param scripts - the package's `scripts` map.
 * @param name - the script to expand, normally `test`.
 * @param seen - names already expanded, which stops a cyclic script from recursing forever.
 * @returns each `bun test …` command string the script reaches, in encounter order.
 */
export function bunTestInvocations(scripts, name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);

  const body = scripts[name];
  if (typeof body !== "string") return [];

  const found = [...body.matchAll(BUN_TEST_CALL)].map((match) => match[0].trim());
  for (const match of body.matchAll(RUN_SCRIPT_CALL)) {
    found.push(...bunTestInvocations(scripts, match[1], seen));
  }
  return found;
}

/**
 * Parse the `[test]` table of a `bunfig.toml` far enough to check the harness rules.
 *
 * @remarks
 * A deliberately small reader rather than a TOML dependency: it needs the keys declared under
 * `[test]`, the entries of `preload` and of `coveragePathIgnorePatterns`, and nothing else. Comment
 * bodies are stripped so a key named inside the prose the root bunfig carries is not read as a
 * declaration.
 *
 * @param text - the file's contents.
 * @returns the declared key names, and the two array values, with `present` false when there is no
 * `[test]` table at all.
 */
export function parseTestTable(text) {
  const lines = text.split("\n");
  let inTable = false;
  let present = false;
  const keys = new Set();
  const arrays = new Map();
  let pendingKey;
  let pendingValue = "";

  const finish = () => {
    if (pendingKey === undefined) return;
    arrays.set(
      pendingKey,
      [...pendingValue.matchAll(/["']([^"']*)["']/g)].map((match) => match[1]),
    );
    pendingKey = undefined;
    pendingValue = "";
  };

  for (const raw of lines) {
    const line = raw.replace(/^\s*#.*$/, "").trim();
    if (line === "") continue;

    if (pendingKey !== undefined) {
      pendingValue += line;
      if (line.includes("]")) finish();
      continue;
    }

    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      inTable = table[1] === "test";
      if (inTable) present = true;
      continue;
    }
    if (!inTable) continue;

    const assignment = /^([\w-]+)\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;
    keys.add(assignment[1]);
    if (!assignment[2].startsWith("[")) continue;
    pendingKey = assignment[1];
    pendingValue = assignment[2];
    if (assignment[2].includes("]")) finish();
  }
  finish();

  return { present, keys, arrays };
}

/**
 * Check one package's test harness against every rule the gate depends on.
 *
 * @param pkg - `name`, its `scripts` map, its `bunfig` text (or `undefined` when absent) and
 * `typeOnly`, which excuses a package that runs no `bun test` at all.
 * @returns one human-readable failure per rule broken, empty when the package is configured.
 */
export function checkPackageHarness(pkg) {
  const failures = [];
  const invocations = bunTestInvocations(pkg.scripts ?? {}, "test");

  if (pkg.typeOnly) {
    if (invocations.length > 0) {
      failures.push(
        `${pkg.name}: declared type-only but its \`test\` script runs \`bun test\`; remove it from the type-only set`,
      );
    }
  } else if (invocations.length === 0) {
    failures.push(
      `${pkg.name}: \`test\` reaches no \`bun test\` invocation, so nothing in this package runs under the gate`,
    );
  }

  const allInvocations = Object.keys(pkg.scripts ?? {})
    .filter((name) => name === "test" || name.startsWith("test:"))
    .flatMap((name) => bunTestInvocations(pkg.scripts, name));
  for (const invocation of allInvocations) {
    if (!invocation.includes(REQUIRED_TIMEOUT)) {
      failures.push(
        `${pkg.name}: \`${invocation}\` omits \`${REQUIRED_TIMEOUT}\`, so it runs on Bun's 5 s default`,
      );
    }
  }

  if (pkg.bunfig === undefined) {
    failures.push(`${pkg.name}: has no bunfig.toml, so a run from its directory reads no settings`);
    return failures;
  }

  const table = parseTestTable(pkg.bunfig);
  if (!table.present) {
    failures.push(`${pkg.name}: bunfig.toml declares no \`[test]\` table`);
    return failures;
  }

  for (const [key, reason] of FORBIDDEN_BUNFIG_KEYS) {
    if (table.keys.has(key)) failures.push(`${pkg.name}: bunfig \`[test] ${key}\` — ${reason}`);
  }

  const preload = table.arrays.get("preload") ?? [];
  if (!pkg.typeOnly && !preload.some((entry) => entry.endsWith(PRELOAD_BASENAME))) {
    failures.push(
      `${pkg.name}: bunfig \`[test] preload\` does not include \`${PRELOAD_BASENAME}\`, so a run from this directory writes into the developer's real CLARVIS_HOME`,
    );
  }

  const ignore = table.arrays.get("coveragePathIgnorePatterns") ?? [];
  if (!ignore.includes(REQUIRED_IGNORE_PATTERN)) {
    failures.push(
      `${pkg.name}: bunfig \`[test] coveragePathIgnorePatterns\` does not include \`${REQUIRED_IGNORE_PATTERN}\`, so workspace dependencies enter this package's ratios`,
    );
  }

  return failures;
}

/**
 * The phases `check:pre-commit` must run, in order.
 *
 * @remarks
 * Each workspace-wide phase already fans out internally, so running two of them beside one another
 * doubles that fan-out and can exhaust a 16 GiB development host. `build` sits immediately before
 * `typecheck` because `typecheck` resolves cross-package types through the built `dist/*.d.ts`.
 */
export const GATE_PHASES = [
  "format:check",
  "build",
  "typecheck",
  "lint:eslint",
  "lint:intent",
  "knip",
  "test:coverage",
];

/**
 * Check that the root build emits the library graph, native assets, worker and terminal application.
 *
 * @param scripts - the root manifest's `scripts` map.
 * @returns one failure per missing or reordered build step.
 */
export function checkRootBuild(scripts) {
  const failures = [];
  if (
    scripts?.["build:packages"] !==
    "tsc -b && bun --filter @clarvis/sandbox build:assets && bun --filter @clarvis/tools build:assets"
  ) {
    failures.push(
      "`build:packages` must build the solution graph, sandbox assets, then tools worker",
    );
  }
  if (scripts?.build !== "bun run build:packages && bun run build:code") {
    failures.push(
      "`build` must run `build:packages` and then `build:code`, so the root build emits every distributable",
    );
  }
  return failures;
}

/**
 * Check that the gate is one strictly sequential `&&` chain in the expected order.
 *
 * @param script - the `check:pre-commit` script body.
 * @returns one failure per deviation, empty when the chain matches {@link GATE_PHASES}.
 */
export function checkGateChain(script) {
  if (typeof script !== "string") return ["`check:pre-commit` is not declared"];

  const failures = [];
  if (script.includes("--parallel")) {
    failures.push(
      "`check:pre-commit` uses `--parallel`; the top-level phases are sequential on purpose",
    );
  }

  const phases = script.split("&&").map((part) => part.trim().replace(/^bun run\s+/, ""));
  if (phases.join(" ") !== GATE_PHASES.join(" ")) {
    failures.push(
      `\`check:pre-commit\` runs \`${phases.join(" -> ")}\`; expected \`${GATE_PHASES.join(" -> ")}\``,
    );
  }
  return failures;
}

/**
 * Expand the deliberately small test-script vocabulary used by this repository.
 * Unknown commands fail closed; this is not a general shell parser.
 */
export function expandTestSuite(
  rootScripts: Record<string, string>,
  packages: Array<{ name: string; scripts: Record<string, string>; testFiles: string[] }>,
  entry: string,
) {
  const failures = [];
  const calls = [];
  const packageByName = new Map(packages.map((pkg) => [pkg.name, pkg] as const));

  function expand(owner, name, stack = []) {
    const id = `${owner}:${name}`;
    if (stack.includes(id)) {
      failures.push(`${entry}: cyclic script ${[...stack, id].join(" -> ")}`);
      return;
    }
    const scripts = owner === "root" ? rootScripts : packageByName.get(owner)?.scripts;
    const body = scripts?.[name];
    if (typeof body !== "string") {
      failures.push(`${entry}: missing script ${id}`);
      return;
    }
    for (const raw of body.split("&&")) {
      const segment = raw.trim();
      let match = /^bun run ([\w:.-]+)$/.exec(segment);
      if (match) {
        expand(owner, match[1], [...stack, id]);
        continue;
      }
      match = /^bun --filter (@clarvis\/[\w-]+) ([\w:.-]+)$/.exec(segment);
      if (match && owner === "root") {
        if (!packageByName.has(match[1])) {
          failures.push(`${entry}: unknown workspace ${match[1]}`);
        } else {
          expand(match[1], match[2], [...stack, id]);
        }
        continue;
      }
      match = /^(?:[A-Z_]+=[^ ]+ )?bun test(?: (.*))?$/.exec(segment);
      if (match) {
        const args = (match[1] ?? "").split(/\s+/).filter(Boolean);
        if (!args.includes("--timeout") || args[args.indexOf("--timeout") + 1] !== "60000") {
          failures.push(`${entry}: ${id} omits --timeout 60000`);
        }
        calls.push({ owner, paths: args.filter((arg) => !arg.startsWith("-") && arg !== "60000") });
        continue;
      }
      if (owner !== "root" && /^tsc -p [\w./-]+$/.test(segment)) continue;
      failures.push(`${entry}: unsupported script segment ${id}: ${segment}`);
    }
  }

  expand("root", entry);
  return { calls, failures };
}

/** Verify every discovered case is reached by the suite matching its resource level. */
export function checkSuiteComposition(
  rootScripts: Record<string, string>,
  packages: Array<{ name: string; scripts: Record<string, string>; testFiles: string[] }>,
  toolingFiles: string[],
) {
  const failures = [];
  if (
    rootScripts["test:coverage"] !==
    "bun --workspaces --sequential --if-present test:coverage && bun run coverage:check"
  ) {
    failures.push("test:coverage: must run every workspace once, then coverage:check");
  }
  const suites = new Map();
  for (const entry of ["test", "test:fast", "test:integration", "test:tooling"]) {
    const expanded = expandTestSuite(rootScripts, packages, entry);
    suites.set(entry, expanded.calls);
    failures.push(...expanded.failures);
  }
  const moduleResolution = expandTestSuite(rootScripts, packages, "test:module-resolution");
  failures.push(...moduleResolution.failures);
  if (
    !moduleResolution.calls.some(
      (call) =>
        call.owner === "root" &&
        call.paths.includes("tooling/tests/integration/module-resolution.test.ts"),
    )
  ) {
    failures.push("test:module-resolution: focused canary is not reached");
  }
  const coverage = new Map();
  for (const pkg of packages) {
    for (const name of Object.keys(pkg.scripts).filter((script) => script.startsWith("test:"))) {
      failures.push(
        ...expandTestSuite(
          { "package-entry": `bun --filter ${pkg.name} ${name}` },
          packages,
          "package-entry",
        ).failures,
      );
    }
    const expanded = expandTestSuite(
      { "package-coverage": `bun --filter ${pkg.name} test:coverage` },
      packages,
      "package-coverage",
    );
    coverage.set(pkg.name, expanded.calls);
    failures.push(...expanded.failures);
  }

  const reached = (entry, owner, file) =>
    (suites.get(entry) ?? []).some((call) => {
      if (call.owner !== owner) return false;
      const relative = owner === "root" ? file : file.replace(/^packages\/[^/]+\//, "");
      return (
        call.paths.length === 0 ||
        call.paths.some((path) => relative === path || relative.startsWith(`${path}/`))
      );
    });

  const moduleResolutionFile = "tooling/tests/integration/module-resolution.test.ts";
  const moduleResolutionRuns = (suites.get("test:tooling") ?? []).filter(
    (call) =>
      call.owner === "root" &&
      (call.paths.length === 0 ||
        call.paths.some(
          (path) => moduleResolutionFile === path || moduleResolutionFile.startsWith(`${path}/`),
        )),
  ).length;
  if (moduleResolutionRuns !== 1) {
    failures.push(
      `test:tooling: module resolution runs ${moduleResolutionRuns} times, expected once`,
    );
  }

  const isNativeTest = (file: string): boolean =>
    file.includes("/integration/native/") || file.endsWith("/native-sandbox.test.ts");
  const files = [
    ...packages.flatMap((pkg) => pkg.testFiles.map((file) => ({ owner: pkg.name, file }))),
    ...toolingFiles.map((file) => ({ owner: "root", file })),
  ];
  if (
    packages.some((pkg) => pkg.name === "@clarvis/protocol") &&
    !rootScripts.test?.includes("bun --filter @clarvis/protocol test")
  ) {
    failures.push("test: type-only @clarvis/protocol contract is omitted");
  }
  for (const { owner, file } of files) {
    const level = testFileLevel(file);
    if (!level) continue;
    if (
      level === "contract" &&
      !file.includes("/contract/memory/") &&
      !file.includes("/contract/physical/")
    ) {
      failures.push(`contract: classify ${file} under memory or physical`);
    }
    const native = isNativeTest(file);
    const physical = level === "integration" || file.includes("/contract/physical/");
    const fast = level === "unit" || level === "component" || file.includes("/contract/memory/");
    const required = native
      ? []
      : ["test", ...(fast ? ["test:fast"] : []), ...(physical ? ["test:integration"] : [])];
    for (const entry of required) {
      if (!reached(entry, owner, file)) failures.push(`${entry}: undiscovered test ${file}`);
    }
    for (const entry of ["test:fast", "test:integration"]) {
      const allowed = entry === "test:fast" ? fast : physical && !native;
      if (!allowed && reached(entry, owner, file)) {
        failures.push(`${entry}: wrong resource level for ${file}`);
      }
    }
    if (owner === "root" && !reached("test:tooling", owner, file)) {
      failures.push(`test:tooling: undiscovered test ${file}`);
    }
    if (owner !== "root") {
      const relative = file.replace(/^packages\/[^/]+\//, "");
      if (
        !(coverage.get(owner) ?? []).some(
          (call) =>
            call.owner === owner &&
            (call.paths.length === 0 ||
              call.paths.some((path) => relative === path || relative.startsWith(`${path}/`))),
        )
      ) {
        failures.push(`test:coverage: undiscovered test ${file}`);
      }
    }
  }
  for (const pkg of packages) {
    const commonFiles = pkg.testFiles.filter(
      (file) => testFileLevel(file) !== undefined && !isNativeTest(file),
    );
    if (commonFiles.length > 0 && !commonFiles.some((file) => reached("test", pkg.name, file))) {
      failures.push(`test: workspace ${pkg.name} is omitted`);
    }
  }
  return failures;
}
