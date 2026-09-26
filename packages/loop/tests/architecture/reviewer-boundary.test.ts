import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function sources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(path) ? [path] : [];
  });
}

test("the loop consumes neutral authorization ports without policy or reviewer imports", () => {
  for (const path of sources(join(import.meta.dir, "../../src"))) {
    const body = readFileSync(path, "utf8");
    expect(body).not.toMatch(/from ["']@clarvis\/(?:execpolicy|judge)["']/);
  }
});
