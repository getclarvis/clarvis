import { describe, expect, it } from "bun:test";
import { DEFAULT_RUNTIME_LIMITS, runtimeSettingsSchema } from "../../src/runtime/settings.ts";

describe("runtime settings", () => {
  it.each(["docker", "podman"])(
    "requires positive safe integer %s limits at save time",
    (backend) => {
      const value = {
        backend,
        image_digest: `sha256:${"a".repeat(64)}`,
        executable: "/injected/engine",
        connection: "local",
        limits: { ...DEFAULT_RUNTIME_LIMITS },
      };
      for (const name of Object.keys(DEFAULT_RUNTIME_LIMITS)) {
        for (const invalid of [0.5, 0, -1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
          expect(
            runtimeSettingsSchema.safeParse({
              ...value,
              limits: { ...value.limits, [name]: invalid },
            }).success,
          ).toBe(false);
        }
      }
    },
  );

  it("keeps native selection minimal", () => {
    expect(runtimeSettingsSchema.parse({ backend: "native" })).toEqual({ backend: "native" });
    expect(() =>
      runtimeSettingsSchema.parse({ backend: "native", image_digest: "latest" }),
    ).toThrow();
  });

  it.each([
    [
      "docker",
      {
        backend: "docker" as const,
        network: "outbound" as const,
        limits: DEFAULT_RUNTIME_LIMITS,
        fallback: "sandbox" as const,
      },
    ],
    [
      "podman",
      {
        backend: "podman" as const,
        network: "outbound" as const,
        limits: DEFAULT_RUNTIME_LIMITS,
      },
    ],
  ] as const)(
    "fills the product-owned %s defaults from one simple selection",
    (backend, expected) => {
      expect(runtimeSettingsSchema.parse({ backend })).toEqual(expected);
    },
  );

  it("accepts only the closed operator-owned Docker recipe contract", () => {
    expect(
      runtimeSettingsSchema.parse({
        backend: "docker",
        recipe: { name: "java-25", script: "/Users/alice/.clarvis/runtime-recipes/java-25.sh" },
      }),
    ).toMatchObject({
      recipe: {
        name: "java-25",
        script: "/Users/alice/.clarvis/runtime-recipes/java-25.sh",
        network: "outbound",
      },
    });
    expect(() =>
      runtimeSettingsSchema.parse({
        backend: "docker",
        recipe: {
          name: "java-25",
          script: "/Users/alice/.clarvis/runtime-recipes/java-25.sh",
          dockerfile: "/tmp/Containerfile",
        },
      }),
    ).toThrow();
    expect(() =>
      runtimeSettingsSchema.parse({
        backend: "docker",
        recipe: {
          name: "Java 25",
          script: "/Users/alice/.clarvis/runtime-recipes/java-25.sh",
        },
      }),
    ).toThrow();
    expect(() =>
      runtimeSettingsSchema.parse({
        backend: "docker",
        recipe: { name: "java-25", script: "recipes/java-25.sh" },
      }),
    ).toThrow();
    expect(() =>
      runtimeSettingsSchema.parse({
        backend: "docker",
        recipe: { name: "java-25", script: "/tmp/java-25.sh\0hidden" },
      }),
    ).toThrow();
    expect(() =>
      runtimeSettingsSchema.parse({
        backend: "podman",
        recipe: {
          name: "java-25",
          script: "/Users/alice/.clarvis/runtime-recipes/java-25.sh",
        },
      }),
    ).toThrow();
  });

  it("keeps advanced Docker and Podman overrides without requiring a complete host contract", () => {
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
    expect(runtimeSettingsSchema.parse(incompletePodman)).toEqual(incompletePodman);
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
