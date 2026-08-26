/**
 * The product version is inlined at build time, and that is the point.
 *
 * @remarks This module exists because its predecessor did the wrong thing
 * quietly: resolving a nearby `package.json` from the emitted artifact could
 * report a host or package-local version. A static import of the root manifest
 * makes the single product version explicit and bundle-safe.
 *
 * It sat on `NO_COUNTER_ALLOWLIST` as a grandfathered untested module. There is
 * no reason for that: importing it is the whole test.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "../bun-test.ts";
import { VERSION } from "../../src/version.ts";

const product = JSON.parse(
  readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("VERSION", () => {
  it("is the root-owned Clarvis product version", () => {
    expect(VERSION).toBe(product.version);
  });

  it("is a plain string a consumer can send on a wire", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
