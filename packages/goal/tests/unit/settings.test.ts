import { describe, expect, it } from "bun:test";
import {
  goalsSettingsSchema,
  goalsSettingsSpec,
  resolveGoalsSettings,
} from "../../src/settings.ts";

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
    });
    expect(
      goalsSettingsSchema.parse({
        max_net_tokens: 4096,
        max_auto_continuations: 0,
        max_no_progress_stages: 1,
        agent: {
          steward: { model: "anthropic/claude-example" },
          formulation: {
            max_net_tokens: 2048,
            timeout_ms: 30_000,
            max_iterations: 4,
            call_timeout_ms: 10_000,
            max_retries: 0,
          },
        },
      }),
    ).toEqual({
      max_net_tokens: 4096,
      max_auto_continuations: 0,
      max_no_progress_stages: 1,
      agent: {
        steward: { model: "anthropic/claude-example" },
        formulation: {
          max_net_tokens: 2048,
          timeout_ms: 30_000,
          max_iterations: 4,
          call_timeout_ms: 10_000,
          max_retries: 0,
        },
      },
    });
  });

  it("accepts the renamed stage limit and normalizes it in memory", () => {
    /**
     * A settings document that still names the previous field must not be discarded
     * whole: the field was accepted by {@link goalsSettingsSchema} before the rename,
     * and the store throws away an entire scope over one unknown key.
     */
    expect(goalsSettingsSchema.parse({ max_no_progress_checkpoints: 2 })).toEqual({
      max_auto_continuations: 8,
      max_no_progress_checkpoints: 2,
    });
    expect(resolveGoalsSettings({ max_no_progress_checkpoints: 2 })).toEqual({
      max_auto_continuations: 8,
      max_no_progress_stages: 2,
    });
    expect(
      resolveGoalsSettings({ max_no_progress_stages: 4, max_no_progress_checkpoints: 2 }),
    ).toEqual({ max_auto_continuations: 8, max_no_progress_stages: 4 });
    expect(resolveGoalsSettings(undefined)).toEqual({ max_auto_continuations: 8 });
    expect(goalsSettingsSchema.safeParse({ max_no_progress_checkpoints: 0 }).success).toBe(false);
  });

  it("rejects unknown fields and invalid creation limits", () => {
    expect(goalsSettingsSchema.safeParse({ max_net_tokens: 0 }).success).toBe(false);
    expect(goalsSettingsSchema.safeParse({ max_auto_continuations: 256 }).success).toBe(false);
    expect(goalsSettingsSchema.safeParse({ arbitrary: true }).success).toBe(false);
    expect(goalsSettingsSchema.safeParse({ agent: { model: "anthropic/legacy" } }).success).toBe(
      false,
    );
    expect(
      goalsSettingsSchema.safeParse({ agent: { formulation: { max_iterations: 9 } } }).success,
    ).toBe(false);
    expect(
      goalsSettingsSchema.safeParse({ agent: { formulation: { max_net_tokens: 160_000_000 } } })
        .success,
    ).toBe(true);
    expect(
      goalsSettingsSchema.safeParse({ agent: { formulation: { arbitrary: true } } }).success,
    ).toBe(false);
    expect(goalsSettingsSchema.safeParse({ agent: { verification: {} } }).success).toBe(false);
  });
});
