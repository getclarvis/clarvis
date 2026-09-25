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
  it("exposes Host and Sandbox as the isolation choices", () => {
    expect(ISOLATION_CHOICES.map((choice) => choice.value)).toEqual(["host", "sandbox"]);
    expect(isolationPlacementLines("sandbox").join(" ")).toContain("workspace");
  });

  it("writes the native sandbox policy for Host and Sandbox", async () => {
    const { settings, writes } = adapter();
    expect(await applyIsolation("sandbox", settings)).toBe("sandbox");
    expect(writes[0]).toMatchObject({
      scope: "global",
      patch: { sandbox: { enabled: true } },
    });
    expect(await applyIsolation("host", settings)).toBe("host");
    expect(writes[1]).toMatchObject({
      scope: "global",
      patch: { sandbox: { enabled: false } },
    });
  });
});
