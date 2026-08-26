import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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

describe("type-only coverage", () => {
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

    if (sourceMtime === "before") {
      await writeFile(join(pkg, "src", "a.ts"), "export const a = 1;\n");
      await new Promise((r) => setTimeout(r, 12));
      await writeFile(join(pkg, "coverage", "lcov.info"), "TN:\nend_of_record\n");
    } else {
      await writeFile(join(pkg, "coverage", "lcov.info"), "TN:\nend_of_record\n");
      await new Promise((r) => setTimeout(r, 12));
      await writeFile(join(pkg, "src", "a.ts"), "export const a = 1;\n");
    }
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
    await new Promise((r) => setTimeout(r, 12));
    await mkdir(join(pkg, "src"), { recursive: true });
    await writeFile(join(pkg, "src", "index.ts"), "export type A = string;\n");

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
