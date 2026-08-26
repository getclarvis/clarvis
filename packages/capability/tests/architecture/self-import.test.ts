import { describe, expect, test } from "../helpers/bun-test.ts";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import path from "node:path";

const SOURCE_ROOT = path.join(import.meta.dir, "..", "..", "src");
const SELF = /from\s+["']@clarvis\/capability(?:\/[^"']*)?["']/u;

describe("@clarvis/capability's own source", () => {
  test("never reaches its own modules through its published package name", async () => {
    const offenders: string[] = [];
    let scanned = 0;
    for await (const relative of new Glob("**/*.ts").scan({ cwd: SOURCE_ROOT })) {
      scanned += 1;
      const text = await readFile(path.join(SOURCE_ROOT, relative), "utf8");
      const code = text.replaceAll(/\/\*\*[\S\s]*?\*\//gu, "");
      if (SELF.test(code)) offenders.push(relative);
    }
    expect(scanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
