import { describe, expect, test } from "bun:test";
import type { GuardModeStore } from "../../src/adapters/guard-mode.ts";
import type { SettingsAdapter, SettingsFile } from "../../src/adapters/settings.ts";
import {
  applySafetyPreset,
  safetyPresetConfirmation,
  SAFETY_PRESET_CHOICES,
} from "../../src/features/run/safety-presets.ts";

describe("safety presets", () => {
  test("publishes the six canonical postures, including direct judge review", () => {
    expect(SAFETY_PRESET_CHOICES.map((choice) => choice.value)).toEqual([
      "free",
      "judged",
      "approval",
      "isolated",
      "reviewed",
      "protected",
    ]);
    expect(SAFETY_PRESET_CHOICES.find((choice) => choice.value === "judged")?.detail).toContain(
      "LLM judge",
    );
  });

  test("warns when direct execution also resets non-default sandbox availability", () => {
    const request = safetyPresetConfirmation("judged", {
      type: "native",
      enabled: true,
      availability: "optional",
    });
    expect(request).toMatchObject({ danger: true, confirmLabel: "use preset" });
    expect(request?.message).toContain("directly on the host");
    expect(request?.detail).toEqual([
      expect.stringContaining("LLM judge"),
      expect.stringContaining("asks you"),
      expect.stringContaining("availability"),
    ]);
  });

  test("a workspace preset preserves inherited command policy and effective toolchains", async () => {
    const writes: { scope: string; patch: Partial<SettingsFile> }[] = [];
    const effective = {
      sandbox: {
        type: "native",
        enabled: true,
        toolchains: { mode: "manual", extra_paths: ["/opt/node/bin"] },
      },
    } as SettingsFile;
    const settings = {
      effective: () => effective,
      read: (scope: "global" | "workspace") =>
        scope === "global"
          ? {
              guard: {
                type: "shell",
                allowed_commands: ["bun test"],
                denied_commands: ["git push --force*"],
              },
            }
          : undefined,
      write: async (scope: string, patch: Partial<SettingsFile>) => {
        writes.push({ scope, patch });
      },
    } as unknown as SettingsAdapter;
    const modes: string[] = [];
    const guard = {
      setMode: (mode: string) => modes.push(mode),
    } as unknown as GuardModeStore;

    await applySafetyPreset("judged", { settings, guard, scope: "workspace" });

    expect(writes).toEqual([
      {
        scope: "workspace",
        patch: {
          guard: {
            type: "shell",
            mode: "auto",
            allowed_commands: ["bun test"],
            denied_commands: ["git push --force*"],
          },
          sandbox: {
            type: "native",
            enabled: false,
            availability: "required",
            filesystem: "workspace-write",
            network: "host",
            toolchains: { mode: "manual", extra_paths: ["/opt/node/bin"] },
          },
        },
      },
    ]);
    expect(modes).toEqual(["auto"]);
  });
});
