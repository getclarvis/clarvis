import { describe, expect, it } from "bun:test";
import { goalsSettingsSchema, goalsSettingsSpec } from "../../src/settings.ts";

describe("goal settings", () => {
  it("owns a strict last-wins creation-default block with bounded defaults", () => {
    expect(goalsSettingsSpec).toMatchObject({
      key: "goals",
      merge: "lastWins",
      pluginContributable: false,
      schema: goalsSettingsSchema,
    });
    expect(goalsSettingsSchema.parse({})).toEqual({
      max_auto_continuations: 8,
      max_no_progress_checkpoints: 3,
    });
    expect(
      goalsSettingsSchema.parse({
        max_net_tokens: 4096,
        max_auto_continuations: 0,
        max_no_progress_checkpoints: 1,
      }),
    ).toEqual({
      max_net_tokens: 4096,
      max_auto_continuations: 0,
      max_no_progress_checkpoints: 1,
    });
  });

  it("rejects unknown fields and invalid creation limits", () => {
    expect(goalsSettingsSchema.safeParse({ max_net_tokens: 0 }).success).toBe(false);
    expect(goalsSettingsSchema.safeParse({ max_auto_continuations: 256 }).success).toBe(false);
    expect(goalsSettingsSchema.safeParse({ arbitrary: true }).success).toBe(false);
  });
});
