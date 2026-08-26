import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { PRODUCT_VERSION } from "../../src/version.ts";

const product = JSON.parse(
  readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("server product version", () => {
  it("comes from the root manifest", () => {
    expect(PRODUCT_VERSION).toBe(product.version);
  });

  it("is passed from the executable to MCP initialization", () => {
    const source = readFileSync(new URL("../../src/bin.ts", import.meta.url), "utf8");
    expect(source).toContain("version: PRODUCT_VERSION");
  });
});
