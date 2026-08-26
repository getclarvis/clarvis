import { describe, expect, it } from "bun:test";

import { isDefaultModelReady } from "../../src/health/model-readiness.ts";

describe("isDefaultModelReady", () => {
  it("requires a default model and its declared provider", () => {
    expect(isDefaultModelReady({}, {})).toBe(false);
    expect(isDefaultModelReady({ default_model: "acme/x", providers: [] }, {})).toBe(false);
  });

  it("accepts a provider that deliberately declares no credential variable", () => {
    expect(
      isDefaultModelReady({ default_model: "local/x", providers: [{ name: "local" }] }, {}),
    ).toBe(true);
  });

  it("checks the resolved environment rather than process.env", () => {
    const settings = {
      default_model: "acme/x",
      providers: [{ name: "acme", api_key_env: "ACME_KEY" }],
    };
    expect(isDefaultModelReady(settings, {})).toBe(false);
    expect(isDefaultModelReady(settings, { ACME_KEY: "from-keyfile-or-env" })).toBe(true);
  });
});
