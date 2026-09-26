import { describe, expect, test } from "bun:test";
import {
  bunTestInvocations,
  checkGateChain,
  checkPackageHarness,
  checkRootBuild,
  checkSuiteComposition,
  expandTestSuite,
  GATE_PHASES,
  parseTestTable,
} from "../../lib/test-harness.ts";

const BUNFIG = `[test]
preload = ["../../tooling/test-runtime/clarvis-home-preload.ts"]
coverageReporter = ["text", "lcov"]
coverageDir = "coverage"
coverageSkipTestFiles = true
coveragePathIgnorePatterns = ["../**"]
`;

const pkg = (over: Record<string, unknown> = {}) => ({
  name: "demo",
  scripts: { test: "bun test --timeout 60000" },
  bunfig: BUNFIG,
  typeOnly: false,
  ...over,
});

describe("resource suite composition", () => {
  const scripts = {
    test: "bun run test:tooling && bun --filter @clarvis/demo test",
    "test:fast": "bun run test:tooling:fast && bun --filter @clarvis/demo test:fast",
    "test:integration":
      "bun run test:tooling:integration && bun --filter @clarvis/demo test:integration",
    "test:tooling":
      "bun run test:tooling:fast && bun test tooling/tests/architecture --timeout 60000 && bun run test:tooling:integration",
    "test:tooling:fast": "bun test tooling/tests/unit --timeout 60000",
    "test:tooling:integration": "bun test tooling/tests/integration --timeout 60000",
    "test:module-resolution":
      "bun test tooling/tests/integration/module-resolution.test.ts --timeout 60000",
    "test:coverage":
      "bun --workspaces --sequential --if-present test:coverage && bun run coverage:check",
  };
  const demo = {
    name: "@clarvis/demo",
    scripts: {
      test: "bun test --timeout 60000",
      "test:fast": "bun test tests/unit tests/contract/memory --timeout 60000",
      "test:integration": "bun test tests/integration tests/contract/physical --timeout 60000",
      "test:coverage": "bun test --timeout 60000 --coverage",
    },
    testFiles: [
      "packages/demo/tests/unit/rule.test.ts",
      "packages/demo/tests/contract/memory/wire.spec.ts",
      "packages/demo/tests/contract/physical/disk_test.ts",
      "packages/demo/tests/integration/host_spec.mts",
      "packages/demo/tests/architecture/exports.test.ts",
    ],
  };
  const tooling = [
    "tooling/tests/unit/check.test.ts",
    "tooling/tests/architecture/policy.spec.ts",
    "tooling/tests/integration/runner_test.ts",
  ];

  test("discovers every filename form and nested contract in its owning command", () => {
    expect(checkSuiteComposition(scripts, [demo], tooling)).toEqual([]);
  });

  test("rejects a forgotten category and a missing workspace script", () => {
    const withoutPhysical = {
      ...scripts,
      "test:integration":
        "bun run test:tooling:integration && bun --filter @clarvis/demo test:fast",
    };
    expect(checkSuiteComposition(withoutPhysical, [demo], tooling).join(" ")).toContain(
      "contract/physical/disk_test.ts",
    );
    expect(
      checkSuiteComposition(
        { ...scripts, "test:fast": "bun run test:tooling:fast" },
        [demo],
        tooling,
      ).join(" "),
    ).toContain("unit/rule.test.ts");
    expect(
      expandTestSuite(
        { ...scripts, "test:fast": "bun --filter @clarvis/demo absent" },
        [demo],
        "test:fast",
      ).failures.join(" "),
    ).toContain("missing script");
    expect(
      checkSuiteComposition(
        scripts,
        [
          {
            ...demo,
            scripts: {
              ...demo.scripts,
              "test:coverage": "bun test tests/unit --timeout 60000 --coverage",
            },
          },
        ],
        tooling,
      ).join(" "),
    ).toContain("test:coverage: undiscovered test");
    expect(
      checkSuiteComposition(
        scripts,
        [
          {
            ...demo,
            testFiles: [...demo.testFiles, "packages/demo/tests/contract/legacy.test.ts"],
          },
        ],
        tooling,
      ).join(" "),
    ).toContain("classify packages/demo/tests/contract/legacy.test.ts");
  });

  test("rejects cycles, unknown workspaces and missing timeouts", () => {
    expect(
      expandTestSuite({ "test:fast": "bun run test:fast" }, [], "test:fast").failures.join(" "),
    ).toContain("cyclic");
    expect(
      expandTestSuite(
        { "test:fast": "bun --filter @clarvis/missing test" },
        [],
        "test:fast",
      ).failures.join(" "),
    ).toContain("unknown workspace");
    expect(
      expandTestSuite(
        { "test:fast": "bun test tooling/tests/unit" },
        [],
        "test:fast",
      ).failures.join(" "),
    ).toContain("--timeout 60000");
  });

  test("rejects a fast suite that reaches physical or architecture cases", () => {
    const broadened = {
      ...scripts,
      "test:tooling:fast": "bun test tooling/tests --timeout 60000",
      "test:fast": "bun run test:tooling:fast && bun --filter @clarvis/demo test",
    };
    const failures = checkSuiteComposition(broadened, [demo], tooling).join(" ");
    expect(failures).toContain(
      "wrong resource level for packages/demo/tests/integration/host_spec.mts",
    );
    expect(failures).toContain(
      "wrong resource level for tooling/tests/architecture/policy.spec.ts",
    );
  });

  test("requires one module resolution run and consolidated workspace coverage", () => {
    const twice = {
      ...scripts,
      "test:tooling": `${scripts["test:tooling"]} && bun run test:module-resolution`,
      "test:coverage": "bun --filter @clarvis/demo test:coverage",
    };
    const failures = checkSuiteComposition(twice, [demo], tooling).join(" ");
    expect(failures).toContain("module resolution runs 2 times");
    expect(failures).toContain("must run every workspace once");
  });

  test("keeps the type-only protocol contract in the full suite", () => {
    const protocol = {
      name: "@clarvis/protocol",
      scripts: {
        test: "bun run test:contract",
        "test:contract": "tsc -p tsconfig.json",
        "test:coverage": "bun run test:contract",
      },
      testFiles: [],
    };
    expect(checkSuiteComposition(scripts, [demo, protocol], tooling).join(" ")).toContain(
      "type-only @clarvis/protocol contract is omitted",
    );
  });
});

describe("bunTestInvocations", () => {
  test("follows a script that delegates to other scripts", () => {
    const scripts = {
      test: "bun run test:unit && bun run test:architecture",
      "test:unit": "bun test tests/unit --timeout 60000",
      "test:architecture": "bun test tests/architecture --timeout 60000",
    };

    expect(bunTestInvocations(scripts, "test")).toEqual([
      "bun test tests/unit --timeout 60000",
      "bun test tests/architecture --timeout 60000",
    ]);
  });

  test("a script that only runs tsc reaches no bun test invocation", () => {
    expect(
      bunTestInvocations({ test: "bun run test:contract", "test:contract": "tsc -p ." }, "test"),
    ).toEqual([]);
  });

  test("a cyclic script terminates instead of recursing forever", () => {
    expect(bunTestInvocations({ a: "bun run b", b: "bun run a" }, "a")).toEqual([]);
  });

  test("both halves of an && chain are read", () => {
    expect(
      bunTestInvocations(
        { test: "bun test tests/unit --timeout 60000 && bun test tests/e2e --timeout 60000" },
        "test",
      ),
    ).toHaveLength(2);
  });
});

describe("parseTestTable", () => {
  test("reads the declared keys and both array values", () => {
    const table = parseTestTable(BUNFIG);

    expect(table.present).toBe(true);
    expect(table.arrays.get("preload")).toEqual([
      "../../tooling/test-runtime/clarvis-home-preload.ts",
    ]);
    expect(table.arrays.get("coveragePathIgnorePatterns")).toEqual(["../**"]);
  });

  test("a key named inside a comment is not a declaration", () => {
    const table = parseTestTable('[test]\n# timeout is NOT set here\ncoverageDir = "coverage"\n');

    expect(table.keys.has("timeout")).toBe(false);
    expect(table.keys.has("coverageDir")).toBe(true);
  });

  test("a key outside the [test] table is ignored", () => {
    expect(parseTestTable('[install]\npreload = ["x"]\n').present).toBe(false);
  });

  test("an array spanning several lines is read whole", () => {
    const table = parseTestTable(
      '[test]\npreload = [\n  "../../tooling/test-runtime/clarvis-home-preload.ts",\n]\n',
    );

    expect(table.arrays.get("preload")).toEqual([
      "../../tooling/test-runtime/clarvis-home-preload.ts",
    ]);
  });
});

describe("checkPackageHarness", () => {
  test("a fully configured package reports nothing", () => {
    expect(checkPackageHarness(pkg())).toEqual([]);
  });

  test("a bun test invocation without the timeout flag is reported", () => {
    expect(checkPackageHarness(pkg({ scripts: { test: "bun test" } })).join(" ")).toContain(
      "5 s default",
    );
  });

  test("a bunfig without the preload names the consequence", () => {
    const failures = checkPackageHarness(
      pkg({ bunfig: '[test]\ncoveragePathIgnorePatterns = ["../**"]\n' }),
    );

    expect(failures.join(" ")).toContain("CLARVIS_HOME");
  });

  test("a bunfig declaring the timeout Bun ignores is reported", () => {
    expect(checkPackageHarness(pkg({ bunfig: `${BUNFIG}timeout = 60000\n` })).join(" ")).toContain(
      "ignores it",
    );
  });

  test("a bunfig declaring a coverage threshold is reported", () => {
    expect(
      checkPackageHarness(pkg({ bunfig: `${BUNFIG}coverageThreshold = 0.9\n` })).join(" "),
    ).toContain("tooling/checks/coverage.ts");
  });

  test("a missing coveragePathIgnorePatterns is reported", () => {
    const bunfig = '[test]\npreload = ["../../tooling/test-runtime/clarvis-home-preload.ts"]\n';

    expect(checkPackageHarness(pkg({ bunfig })).join(" ")).toContain("workspace dependencies");
  });

  test("a package with no bunfig at all is reported once", () => {
    expect(checkPackageHarness(pkg({ bunfig: undefined }))).toHaveLength(1);
  });

  test("a type-only package needs neither the flag nor the preload", () => {
    expect(
      checkPackageHarness({
        name: "protocol",
        scripts: { test: "bun run test:contract", "test:contract": "tsc -p tsconfig.json" },
        bunfig: '[test]\ncoveragePathIgnorePatterns = ["../**"]\n',
        typeOnly: true,
      }),
    ).toEqual([]);
  });

  test("a type-only package that does run bun test is reported, not excused", () => {
    expect(checkPackageHarness(pkg({ typeOnly: true })).join(" ")).toContain("declared type-only");
  });

  test("a package whose test script runs nothing is reported", () => {
    expect(checkPackageHarness(pkg({ scripts: { test: "echo skip" } })).join(" ")).toContain(
      "reaches no `bun test` invocation",
    );
  });
});

describe("checkGateChain", () => {
  const chain = GATE_PHASES.map((phase) => `bun run ${phase}`).join(" && ");

  test("the expected chain passes", () => {
    expect(checkGateChain(chain)).toEqual([]);
  });

  test("a dropped phase is reported", () => {
    expect(checkGateChain(chain.replace("bun run knip && ", "")).join(" ")).toContain("expected");
  });

  test("a reordered chain is reported", () => {
    const swapped = ["typecheck", "build", ...GATE_PHASES.slice(2)]
      .map((phase) => `bun run ${phase}`)
      .join(" && ");

    expect(checkGateChain(swapped)).toHaveLength(1);
  });

  test("restoring a top-level --parallel is reported on its own", () => {
    expect(checkGateChain(`${chain} --parallel`).join(" ")).toContain("sequential on purpose");
  });

  test("an absent script is reported rather than passing vacuously", () => {
    expect(checkGateChain(undefined)).toHaveLength(1);
  });
});

describe("checkRootBuild", () => {
  const scripts = {
    build: "bun run build:packages && bun run build:code",
    "build:packages":
      "tsc -b && bun --filter @clarvis/sandbox build:assets && bun --filter @clarvis/tools build:assets",
    "build:code": "bun --filter @clarvis/code build",
  };

  test("accepts the complete sequential root build", () => {
    expect(checkRootBuild(scripts)).toEqual([]);
  });

  test("rejects a root build that omits the code artifact", () => {
    expect(checkRootBuild({ ...scripts, build: "bun run build:packages" }).join(" ")).toContain(
      "every distributable",
    );
  });

  test("rejects a package build missing the graph or either execution asset", () => {
    for (const incomplete of [
      "echo skip && bun --filter @clarvis/sandbox build:assets && bun --filter @clarvis/tools build:assets",
      "tsc -b && bun --filter @clarvis/tools build:assets",
      "tsc -b && bun --filter @clarvis/sandbox build:assets",
    ]) {
      expect(checkRootBuild({ ...scripts, "build:packages": incomplete }).join(" ")).toContain(
        "sandbox assets",
      );
    }
  });
});
