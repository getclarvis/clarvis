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

function importsUnder(layer: string): Array<{ file: string; specifier: string }> {
  return sourceFiles(join(SRC, layer)).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g)].map(
      (match) => ({
        file: relative(SRC, file).split(sep).join("/"),
        specifier: match[2] ?? "",
      }),
    ),
  );
}

describe("kernel dependency direction", () => {
  it("keeps contracts and application policy independent from concrete effects", () => {
    const offenders = ["application", "core", "ports"]
      .flatMap(importsUnder)
      .filter(
        ({ specifier }) =>
          specifier === "node:fs" ||
          specifier === "node:fs/promises" ||
          specifier === "node:child_process" ||
          specifier.includes("/adapters/") ||
          specifier.includes("file-kernel"),
      );
    expect(offenders).toEqual([]);
  });

  it("keeps transport independent from file-backed composition", () => {
    const offenders = importsUnder("transport").filter(
      ({ specifier }) => specifier.includes("/adapters/") || specifier.includes("file-kernel"),
    );
    expect(offenders).toEqual([]);
  });

  it("does not reach the removed generic loop-internal surface", () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      readFileSync(file, "utf8").includes("@clarvis/loop/internal"),
    );
    expect(offenders).toEqual([]);
  });
});
