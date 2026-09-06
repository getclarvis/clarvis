import { describe, expect, it } from "bun:test";
import { DEFAULT_RUNTIME_LIMITS, runtimeSettingsSchema } from "../../src/runtime/settings.ts";

describe("runtime settings", () => {
  it("keeps native selection minimal", () => {
    expect(runtimeSettingsSchema.parse({ backend: "native" })).toEqual({ backend: "native" });
    expect(() =>
      runtimeSettingsSchema.parse({ backend: "native", image_digest: "latest" }),
    ).toThrow();
  });

  it("fills the product-owned Docker defaults from one simple selection", () => {
    expect(runtimeSettingsSchema.parse({ backend: "docker" })).toEqual({
      backend: "docker",
      network: "outbound",
      limits: DEFAULT_RUNTIME_LIMITS,
      fallback: "sandbox",
    });
  });

  it("keeps advanced Docker overrides and requires Podman's full host contract", () => {
    const value = {
      backend: "podman" as const,
      image_digest: `sha256:${"a".repeat(64)}`,
      network: "none" as const,
      executable: "/usr/bin/podman",
      connection: "local",
      limits: {
        cpu_count: 2,
        memory_bytes: 1024,
        process_count: 32,
        output_bytes: 2048,
        storage_bytes: 4096,
      },
    };
    expect(runtimeSettingsSchema.parse(value)).toEqual(value);
    expect(runtimeSettingsSchema.parse({ ...value, backend: "docker" })).toEqual({
      ...value,
      backend: "docker",
      fallback: "sandbox",
    });
    const { executable: _executable, ...incompletePodman } = value;
    expect(() => runtimeSettingsSchema.parse(incompletePodman)).toThrow();
    expect(() => runtimeSettingsSchema.parse({ ...value, image_digest: "latest" })).toThrow();
    expect(() =>
      runtimeSettingsSchema.parse({ ...value, limits: { ...value.limits, process_count: 0 } }),
    ).toThrow();
    expect(() =>
      runtimeSettingsSchema.parse({ ...value, engine_args: ["--privileged"] }),
    ).toThrow();
    const { network: _network, ...withoutNetwork } = value;
    expect(runtimeSettingsSchema.parse(withoutNetwork)).toEqual({
      ...withoutNetwork,
      network: "outbound",
    });
  });
});
