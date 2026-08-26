import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { CLIENT_NAME, VERSION } from "../../src/version.ts";

const product = JSON.parse(
  readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("MCP client identity", () => {
  it("uses the root-owned Clarvis product version", () => {
    expect(CLIENT_NAME).toBe("@clarvis/mcp-client");
    expect(VERSION).toBe(product.version);
  });
});
