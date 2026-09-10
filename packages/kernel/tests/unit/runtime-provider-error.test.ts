import { describe, expect, it } from "bun:test";
import { ProviderError } from "@clarvis/capability";
import {
  decodeRuntimeProviderError,
  encodeRuntimeProviderError,
  runtimeProviderErrorSchema,
} from "../../src/runtime/provider-error.ts";

describe("runtime provider usage uncertainty", () => {
  it("retains partial counters and uncertainty through the closed JSON error codec", () => {
    const partialUsage = {
      input_tokens: 100,
      output_tokens: 2,
      cached_tokens: 0,
      cache_write_tokens: 0,
      usage_unknown: true as const,
      cache_unknown: true as const,
    };
    const error = new ProviderError("Provider interrupted", { partialUsage });
    error.accumulatedUsage = { ...partialUsage, input_tokens: 200 };
    const encoded = encodeRuntimeProviderError(error);
    const provider = runtimeProviderErrorSchema.parse(JSON.parse(JSON.stringify(encoded.provider)));
    const decoded = decodeRuntimeProviderError(encoded.message, provider);
    expect(decoded.partialUsage).toEqual(partialUsage);
    expect(decoded.accumulatedUsage).toEqual(error.accumulatedUsage);
    expect(
      runtimeProviderErrorSchema.safeParse({
        ...provider,
        partialUsage: { ...partialUsage, usage_unknown: false },
      }).success,
    ).toBe(false);
    expect(
      runtimeProviderErrorSchema.safeParse({
        ...provider,
        partialUsage: { ...partialUsage, secret: "synthetic" },
      }).success,
    ).toBe(false);
  });
});
