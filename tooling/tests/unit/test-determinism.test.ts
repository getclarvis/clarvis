import { describe, expect, test } from "bun:test";
import {
  baselineFromOccurrences,
  checkTestDeterminismBaseline,
  findTestDeterminismOccurrences,
  findTestDeterminismOccurrencesInFile,
  normalizeTestPath,
} from "../../lib/test-determinism.ts";
import { main as checkerMain } from "../../checks/test-determinism.ts";

const mechanisms = (source: string) =>
  findTestDeterminismOccurrencesInFile("packages/demo/tests/unit/fixture.test.ts", source);

describe("test determinism AST census", () => {
  test("finds direct, indexed and delete environment mutations", () => {
    const findings = mechanisms(`
      process.env.DIRECT = "x";
      process.env["INDEXED"] += "x";
      delete process.env.REMOVED;
      Object.assign(process.env, { ASSIGNED: "x" });
      Object.defineProperty(process.env, "DEFINED", { value: "x" });
    `);
    expect(findings.map((finding) => finding.mechanism)).toEqual(
      new Array(5).fill("process-env-mutation"),
    );
  });

  test("does not confuse reads, comparisons, fallbacks or spreads with writes", () => {
    expect(
      mechanisms(`
        const value = process.env.DIRECT;
        const same = process.env === process.env;
        const fallback = process.env.MISSING ?? "fallback";
        const copy = { ...process.env };
      `),
    ).toEqual([]);
  });

  test("distinguishes platform redefinition from platform reads", () => {
    const findings = mechanisms(`
      const current = process.platform;
      process.platform = "linux";
      Object.defineProperty(process, "platform", { value: "darwin" });
    `);
    expect(findings.map((finding) => finding.mechanism)).toEqual([
      "process-platform-redefinition",
      "process-platform-redefinition",
    ]);
  });

  test("finds process.chdir and Math.random assignment", () => {
    const findings = mechanisms(`
      process.chdir("/tmp");
      Math.random = () => 0.5;
      Math.random();
    `);
    expect(findings.map((finding) => finding.mechanism)).toEqual([
      "process-chdir",
      "math-random-assignment",
    ]);
  });

  test("finds positive literal waits and timers, but not zero or variable delays", () => {
    const findings = mechanisms(`
      await Bun.sleep(5);
      await Bun.sleep(0);
      setTimeout(done, 1_000);
      setInterval(done, -1);
      setTimeout(done, delay);
      const text = "Bun.sleep(50); setTimeout(done, 50)";
    `);
    expect(findings.map((finding) => finding.mechanism)).toEqual(["positive-wait", "timer"]);
  });

  test("reports fake timers only when no lifecycle or finally restoration exists", () => {
    expect(
      mechanisms(`
        vi.useFakeTimers();
        afterEach(() => vi.useRealTimers());
      `).filter((finding) => finding.mechanism === "fake-timers"),
    ).toEqual([]);
    expect(
      mechanisms(`
        vi.useFakeTimers();
        vi.useRealTimers();
      `).filter((finding) => finding.mechanism === "fake-timers"),
    ).toEqual([]);
    expect(
      mechanisms(`
        test("restores", () => {
          vi.useFakeTimers();
          try { return 1; } finally { vi.useRealTimers(); }
        });
      `).filter((finding) => finding.mechanism === "fake-timers"),
    ).toEqual([]);
    expect(
      mechanisms(`
        beforeEach(() => vi.useFakeTimers());
      `).map((finding) => finding.mechanism),
    ).toEqual(["fake-timers"]);
  });

  test("finds mutable beforeAll fixtures and inventories real boundaries", () => {
    const findings = mechanisms(`
      beforeAll(async () => {
        await mkdir("fixture");
        const server = createServer();
        server.listen(0);
        fs.watch("fixture", () => {});
        Bun.spawn(["echo", "ok"]);
      });
    `);
    expect(findings.map((finding) => finding.mechanism)).toEqual([
      "before-all-mutation",
      "listener",
      "subprocess",
    ]);
    expect(
      findings.find((finding) => finding.mechanism === "before-all-mutation")?.reason,
    ).toContain("directory, listener, subprocess, watcher");
  });
});

describe("test determinism baseline", () => {
  test("creates classified canary entries with package owners", () => {
    const occurrences = mechanisms(`Bun.spawn(["echo"]);`);
    const baseline = baselineFromOccurrences(occurrences);
    expect(baseline.entries[0]).toMatchObject({
      package_owner: "@clarvis/demo",
      classification: "boundary-canary",
    });
    expect(baseline.entries[0]?.reason).toBeTruthy();
  });

  test("rejects new, stale, duplicate, malformed and owner-inconsistent rows", () => {
    const occurrences = mechanisms(`Bun.sleep(5);`);
    const baseline = baselineFromOccurrences(occurrences);
    const good = checkTestDeterminismBaseline(occurrences, baseline);
    expect(good.failures).toEqual([]);

    const stale = checkTestDeterminismBaseline(occurrences, {
      ...baseline,
      entries: [
        ...baseline.entries,
        {
          ...baseline.entries[0],
          identity: "removed-identity",
          reason: "legacy",
        },
      ],
    });
    expect(stale.failures.some((failure) => failure.includes("stale baseline entry"))).toBe(true);

    const duplicate = checkTestDeterminismBaseline(occurrences, {
      ...baseline,
      entries: [...baseline.entries, baseline.entries[0]],
    });
    expect(
      duplicate.failures.some((failure) => failure.includes("duplicate baseline identity")),
    ).toBe(true);

    const malformed = checkTestDeterminismBaseline(occurrences, {
      ...baseline,
      entries: [{ ...baseline.entries[0], reason: "", package_owner: "wrong" }],
    });
    expect(malformed.failures.some((failure) => failure.includes("baseline reason is empty"))).toBe(
      true,
    );
    expect(malformed.failures.some((failure) => failure.includes("owner mismatch"))).toBe(true);

    const emptyFields = checkTestDeterminismBaseline(occurrences, {
      ...baseline,
      entries: [{ ...baseline.entries[0], identity: "", package_owner: "", reason: "legacy" }],
    });
    expect(emptyFields.failures).toContain("baseline identity is empty");
    expect(emptyFields.failures).toContain("baseline package owner is empty");

    const malformedShape = checkTestDeterminismBaseline(occurrences, {
      ...baseline,
      entries: [null] as never,
    });
    expect(malformedShape.failures).toContain("baseline entry must be an object");

    const newer = checkTestDeterminismBaseline(
      [...occurrences, ...mechanisms(`setTimeout(done, 5);`)],
      baseline,
    );
    expect(newer.newOccurrences).toHaveLength(1);
    expect(newer.failures.some((failure) => failure.includes("new unclassified occurrence"))).toBe(
      true,
    );
  });

  test("normalizes Windows and POSIX paths and keeps structural identities line-independent", () => {
    expect(normalizeTestPath(".\\packages\\demo\\tests\\unit\\fixture.test.ts")).toBe(
      "packages/demo/tests/unit/fixture.test.ts",
    );
    const first = findTestDeterminismOccurrencesInFile("fixture.test.ts", "Bun.sleep(5);");
    const shifted = findTestDeterminismOccurrencesInFile("fixture.test.ts", "\n\nBun.sleep(5);");
    expect(first[0]?.identity).toBe(shifted[0]?.identity);
  });

  test("supports the multi-file overload and importing the checker has no side effect", () => {
    const findings = findTestDeterminismOccurrences([
      { file: "fixture.test.ts", source: "Bun.sleep(1);" },
    ]);
    expect(findings).toHaveLength(1);
    expect(typeof checkerMain).toBe("function");
  });
});
