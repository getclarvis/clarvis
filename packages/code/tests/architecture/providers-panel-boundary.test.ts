import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("providers panel boundary", () => {
  test("does not add package entrypoints for internal provider screens", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, unknown> };
    expect(
      Object.keys(manifest.exports ?? {}).filter((path) => path.includes("providers")),
    ).toEqual([]);
  });
});
