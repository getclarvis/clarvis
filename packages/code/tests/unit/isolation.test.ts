import { describe, expect, it } from "bun:test";
import {
  applyIsolation,
  isolationPlacementLines,
  ISOLATION_CHOICES,
} from "../../src/features/run/isolation.ts";
import type { SettingsAdapter, SettingsFile } from "../../src/adapters/settings.ts";

function adapter(initial: SettingsFile = {}): {
  settings: SettingsAdapter;
  writes: Array<{ scope: string; patch: unknown }>;
} {
  const effective: SettingsFile = { ...initial };
  const writes: Array<{ scope: string; patch: unknown }> = [];
  const settings = {
    effective: () => effective,
    write: async (scope: string, patch: unknown) => {
      writes.push({ scope, patch });
      Object.assign(effective, patch as object);
    },
  } as unknown as SettingsAdapter;
  return { settings, writes };
}

describe("applyIsolation", () => {
  it("exposes Host, Sandbox, Docker and Podman as one choice list", () => {
    expect(ISOLATION_CHOICES.map((choice) => choice.value)).toEqual([
      "host",
      "sandbox",
      "docker",
      "podman",
    ]);
    expect(isolationPlacementLines("podman").join(" ")).toContain("fails closed");
  });

  it("persists each container engine as a simple global runtime selection", async () => {
    for (const backend of ["docker", "podman"] as const) {
      const { settings, writes } = adapter({
        sandbox: { type: "native", enabled: true },
      });
      expect(await applyIsolation(backend, settings)).toBe(backend);
      expect(writes).toEqual([
        {
          scope: "global",
          patch: {
            runtime: { backend },
            sandbox: {
              type: "native",
              enabled: true,
              availability: "required",
              filesystem: "workspace-write",
              network: "host",
              toolchains: { mode: "auto" },
            },
          },
        },
      ]);
    }
  });

  it("writes native runtime for Host and Sandbox", async () => {
    const { settings, writes } = adapter();
    expect(await applyIsolation("sandbox", settings)).toBe("sandbox");
    expect(writes[0]).toMatchObject({
      scope: "global",
      patch: { runtime: { backend: "native" }, sandbox: { enabled: true } },
    });
    expect(await applyIsolation("host", settings)).toBe("host");
    expect(writes[1]).toMatchObject({
      scope: "global",
      patch: { runtime: { backend: "native" }, sandbox: { enabled: false } },
    });
  });
});
