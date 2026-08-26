import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "bun:test";

const SRC = join(import.meta.dir, "..", "..", "src");

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : entry.name.endsWith(".ts") ? [file] : [];
  });
}

describe("workflows dependency direction", () => {
  it("reaches the engine only through its two supported workflow seams", () => {
    const imports = sourceFiles(SRC).flatMap((file) =>
      [
        ...readFileSync(file, "utf8").matchAll(
          /(?:from\s+|import\s*\()(["'])(@clarvis\/loop[^"']*)\1/g,
        ),
      ].map((match) => ({
        file: relative(SRC, file).split(sep).join("/"),
        specifier: match[2] ?? "",
      })),
    );
    expect(imports.sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: "elicit-mux.ts", specifier: "@clarvis/loop/workflows" },
      { file: "types.ts", specifier: "@clarvis/loop" },
    ]);
  });

  it("does not import the removed generic loop-internal surface", () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      readFileSync(file, "utf8").includes("@clarvis/loop/internal"),
    );
    expect(offenders).toEqual([]);
  });
});
