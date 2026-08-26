import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

describe("kernel public surface", () => {
  it("publishes only the five owned entrypoints", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };
    expect(Object.keys(manifest.exports).sort()).toEqual([
      ".",
      "./bootstrap",
      "./config",
      "./local",
      "./policy",
    ]);
    for (const target of Object.values(manifest.exports)) {
      expect(Object.keys(target as Record<string, string>)).toEqual(["bun", "types", "import"]);
    }
  });

  it("does not restore generic lower-package barrels at the root", () => {
    const root = readFileSync(join(import.meta.dir, "..", "..", "src", "index.ts"), "utf8");
    expect(root).not.toMatch(/export\s+\*\s+from/);
    expect(root).not.toContain("./reexports/");
    for (const dependency of [
      "@clarvis/capability",
      "@clarvis/loop",
      "@clarvis/memory",
      "@clarvis/workflows",
    ]) {
      expect(root).not.toContain(`from "${dependency}`);
    }
  });
});
