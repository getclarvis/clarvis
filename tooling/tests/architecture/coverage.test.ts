import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCoverage,
  coverageWorkspaceFailures,
  findUnmeasuredSources,
  readOwnSourceCoverage,
  staleReport,
} from "../../checks/coverage.ts";

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clarvis-coverage-"));
  fixtureRoots.push(root);
  const sourceDir = join(root, "packages", "protocol", "src");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "index.ts"), source);
  return root;
}

describe("coverage workspace policy", () => {
  async function census() {
    const root = await mkdtemp(join(tmpdir(), "clarvis-coverage-inventory-"));
    fixtureRoots.push(root);
    const { workspaces } = JSON.parse(await Bun.file("package.json").text()) as {
      workspaces: string[];
    };
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces }));
    for (const workspace of workspaces) {
      await mkdir(join(root, workspace), { recursive: true });
      await writeFile(
        join(root, workspace, "package.json"),
        await Bun.file(join(workspace, "package.json")).text(),
      );
    }
    return { root, workspaces };
  }

  test("matches every current workspace to the existing coverage policy", async () => {
    expect(await coverageWorkspaceFailures()).toEqual([]);
  });

  test("rejects a new workspace without a floor before accepting any reports", async () => {
    const { root, workspaces } = await census();
    workspaces.push("packages/new-package");
    await mkdir(join(root, "packages/new-package"));
    await writeFile(
      join(root, "packages/new-package/package.json"),
      JSON.stringify({ name: "@clarvis/new-package", scripts: { "test:coverage": "bun test" } }),
    );
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces }));
    expect(await coverageWorkspaceFailures(root)).toEqual([
      "new-package: workspace has no coverage floor",
    ]);
    await expect(checkCoverage(root)).rejects.toThrow("Coverage workspace policy");
  });

  test("rejects a floor whose workspace was removed", async () => {
    const { root, workspaces } = await census();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        workspaces: workspaces.filter((workspace) => workspace !== "packages/code"),
      }),
    );
    expect(await coverageWorkspaceFailures(root)).toEqual([
      "code: coverage floor has no workspace",
    ]);
    await expect(checkCoverage(root)).rejects.toThrow("Coverage workspace policy");
  });

  test("protocol's LCOV exception does not excuse a missing contract script", async () => {
    const { root } = await census();
    await writeFile(
      join(root, "packages/protocol/package.json"),
      JSON.stringify({ name: "@clarvis/protocol", scripts: {} }),
    );
    await expect(coverageWorkspaceFailures(root)).rejects.toThrow("missing test:coverage script");
  });
});

describe("type-only coverage", () => {
  test("rejects an empty runtime report rather than accepting a partial denominator", async () => {
    const root = await fixture("export interface Contract { id: string }\n");
    await mkdir(join(root, "packages", "kernel", "coverage"), { recursive: true });
    await writeFile(
      join(root, "packages", "kernel", "coverage", "lcov.info"),
      "TN:\nend_of_record\n",
    );
    await expect(readOwnSourceCoverage("kernel", root)).rejects.toThrow("no own-source line data");
  });

  test("accepts an absent LCOV report only for a declared type-only package", async () => {
    const root = await fixture("export interface Contract { id: string }\n");

    const coverage = await readOwnSourceCoverage("protocol", root);

    expect(coverage).toEqual({ functions: 1, lines: 1, measured: new Set() });
    await expect(readOwnSourceCoverage("kernel", root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not mistake a missing type-only package for a missing report", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-coverage-"));
    fixtureRoots.push(root);

    await expect(readOwnSourceCoverage("protocol", root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("still reports runtime exports even when stale LCOV names the module", async () => {
    const root = await fixture('export const version = "0.0.0";\n');

    const result = await findUnmeasuredSources("protocol", new Set(["src/index.ts"]), root);

    expect(result.unmeasured).toEqual([]);
    expect(result.runtimeExports).toEqual(["src/index.ts"]);
  });

  test("accepts type declarations and type-only re-exports", async () => {
    const root = await fixture(
      'export interface Contract { id: string }\nexport type * from "./other.js";\n',
    );
    await writeFile(
      join(root, "packages", "protocol", "src", "other.ts"),
      "export type Id = string;\n",
    );

    const result = await findUnmeasuredSources("protocol", new Set(), root);

    expect(result.unmeasured).toEqual([]);
    expect(result.runtimeExports).toEqual([]);
  });
});

/**
 * A coverage report is only as fresh as the last run that wrote it.
 *
 * @remarks Every figure this script prints comes from whatever LCOV is on disk.
 * The gate cannot be bitten — `test:coverage` runs immediately before — but the
 * script invoked on its own reports the previous run's numbers, and a source
 * file added since then appears as "produced no coverage record at all". Both
 * read as findings about the code rather than about the report's age; saying so
 * is cheaper than either confusion.
 */
describe("staleReport", () => {
  async function withReport(sourceMtime: "before" | "after"): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "clarvis-coverage-"));
    fixtureRoots.push(root);
    const pkg = join(root, "packages", "trace");
    await mkdir(join(pkg, "src"), { recursive: true });
    await mkdir(join(pkg, "coverage"), { recursive: true });

    const source = join(pkg, "src", "a.ts");
    const report = join(pkg, "coverage", "lcov.info");
    await writeFile(source, "export const a = 1;\n");
    await writeFile(report, "TN:\nend_of_record\n");
    const sourceInstant = new Date(
      sourceMtime === "before" ? "2026-01-01T00:00:00Z" : "2026-01-02T00:00:00Z",
    );
    const reportInstant = new Date(
      sourceMtime === "before" ? "2026-01-02T00:00:00Z" : "2026-01-01T00:00:00Z",
    );
    await utimes(source, sourceInstant, sourceInstant);
    await utimes(report, reportInstant, reportInstant);
    return root;
  }

  test("names the source that outran the report", async () => {
    expect(await staleReport("trace", await withReport("after"))).toBe("src/a.ts");
  });

  test("says nothing when the report is the newer of the two", async () => {
    expect(await staleReport("trace", await withReport("before"))).toBeNull();
  });

  test("says nothing when there is no report to be stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-coverage-"));
    fixtureRoots.push(root);
    await mkdir(join(root, "packages", "trace", "src"), { recursive: true });
    expect(await staleReport("trace", root)).toBeNull();
  });

  test("stays quiet for a type-only package, whose report is never regenerated", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-coverage-"));
    fixtureRoots.push(root);
    const pkg = join(root, "packages", "protocol");
    await mkdir(join(pkg, "coverage"), { recursive: true });
    await writeFile(join(pkg, "coverage", "lcov.info"), "TN:\n");
    await mkdir(join(pkg, "src"), { recursive: true });
    const source = join(pkg, "src", "index.ts");
    await writeFile(source, "export type A = string;\n");
    await utimes(
      join(pkg, "coverage", "lcov.info"),
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-01T00:00:00Z"),
    );
    await utimes(source, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));

    expect(await staleReport("protocol", root)).toBeNull();
  });

  test("says nothing when the package has no src tree at all", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-coverage-"));
    fixtureRoots.push(root);
    await mkdir(join(root, "packages", "trace", "coverage"), { recursive: true });
    await writeFile(join(root, "packages", "trace", "coverage", "lcov.info"), "TN:\n");
    expect(await staleReport("trace", root)).toBeNull();
  });
});
