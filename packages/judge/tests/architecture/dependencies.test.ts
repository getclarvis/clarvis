import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
test("Judge keeps its runtime imports below its host and product peers", () => {
  const allowed = new Set(["@clarvis/capability", "@clarvis/loop", "zod"]);
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  for (const dependency of Object.keys(manifest.dependencies))
    expect(allowed.has(dependency)).toBe(true);
  for (const file of new Bun.Glob("src/**/*.ts").scanSync(root)) {
    const text = readFileSync(resolve(root, file), "utf8");
    for (const [, dependency] of text.matchAll(
      /(?:from\s+|import\s*\()["'](@clarvis\/[^"']+)["']/g,
    ))
      expect(allowed.has(dependency!.split("/").slice(0, 2).join("/"))).toBe(true);
    expect(text).not.toMatch(/packages\/(kernel|tools|protocol|goal|memory|plan|workflows)/);
  }
});
