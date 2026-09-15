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
        agent: {
          model: "anthropic/claude-example",
          formulation: {
            max_net_tokens: 2048,
            timeout_ms: 30_000,
            max_iterations: 4,
            call_timeout_ms: 10_000,
            max_retries: 0,
          },
          verification: {
            stage_token_limit: 3000,
            attempt_token_limit: 1500,
            max_attempts: 2,
            iteration_limit: 4,
            timeout_ms: 30_000,
            call_timeout_ms: 10_000,
          },
        },
      }),
    ).toEqual({
      max_net_tokens: 4096,
      max_auto_continuations: 0,
      max_no_progress_checkpoints: 1,
      agent: {
        model: "anthropic/claude-example",
        formulation: {
          max_net_tokens: 2048,
          timeout_ms: 30_000,
          max_iterations: 4,
          call_timeout_ms: 10_000,
          max_retries: 0,
        },
        verification: {
          stage_token_limit: 3000,
          attempt_token_limit: 1500,
          max_attempts: 2,
          iteration_limit: 4,
          timeout_ms: 30_000,
          call_timeout_ms: 10_000,
        },
      },
    });
  });

  it("rejects unknown fields and invalid creation limits", () => {
    expect(goalsSettingsSchema.safeParse({ max_net_tokens: 0 }).success).toBe(false);
    expect(goalsSettingsSchema.safeParse({ max_auto_continuations: 256 }).success).toBe(false);
    expect(goalsSettingsSchema.safeParse({ arbitrary: true }).success).toBe(false);
    expect(goalsSettingsSchema.safeParse({ agent: { model: "unqualified" } }).success).toBe(false);
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
    expect(
      goalsSettingsSchema.safeParse({ agent: { verification: { max_attempts: 4 } } }).success,
    ).toBe(false);
    expect(
      goalsSettingsSchema.safeParse({ agent: { verification: { arbitrary: true } } }).success,
    ).toBe(false);
  });
});
