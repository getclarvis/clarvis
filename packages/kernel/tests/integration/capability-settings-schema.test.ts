import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalPaths } from "@clarvis/paths";
import { settingsSchema } from "@clarvis/loop/host";
import {
  createConfigService,
  createFileConfigStore,
  createMemoryConfigStore,
  kernelSettingsSchema,
} from "../../src/config.ts";

// `workflows` is contributed by @clarvis/workflows through the kernel's capability
// registry rather than spread into the engine's static schema, so the bare
// `settingsSchema` rejects it and only `kernelSettingsSchema` admits it. Every
// consumer that validates a settings.json — including @clarvis/code — must use the
// exported kernel schema.

const workflowsBlock = { default_model: "compat/m", workflows: { max_concurrency: 8 } };

describe("kernelSettingsSchema", () => {
  it("admits a registered capability's block that the engine's bare schema rejects", () => {
    expect(settingsSchema.safeParse(workflowsBlock).success).toBe(false);
    const parsed = kernelSettingsSchema.safeParse(workflowsBlock);
    expect(parsed.success).toBe(true);
    expect((parsed.data as Record<string, unknown>).workflows).toMatchObject({
      max_concurrency: 8,
      budget_tokens: 640_000_000,
    });
  });

  it("still rejects an unrecognized key, so registration is not a blanket passthrough", () => {
    const parsed = kernelSettingsSchema.safeParse({ ...workflowsBlock, not_a_block: 1 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
  });

  it("rejects a workflows block whose own schema is violated", () => {
    expect(kernelSettingsSchema.safeParse({ workflows: { max_concurrency: 0 } }).success).toBe(
      false,
    );
    expect(kernelSettingsSchema.safeParse({ workflows: { bogus: true } }).success).toBe(false);
  });

  // The `memory` block took the same route out of the engine as `workflows`: it
  // is declared by @clarvis/memory/settings and registered here, so the bare
  // engine schema no longer knows it. These are the assertions that used to live
  // in the loop's own settings-schema suite.
  it("admits the memory block and applies its defaults", () => {
    const block = { memory: { model: "anthropic/claude-haiku", budgets: { max_index_ops: 4 } } };
    expect(settingsSchema.safeParse(block).success).toBe(false);
    const parsed = kernelSettingsSchema.safeParse(block);
    expect(parsed.success).toBe(true);
    expect((parsed.data as Record<string, unknown>).memory).toMatchObject({
      enabled: true,
      model: "anthropic/claude-haiku",
    });
    expect(kernelSettingsSchema.safeParse({ memory: {} }).success).toBe(true);
  });

  it("rejects unknown keys inside memory (strict)", () => {
    const parsed = kernelSettingsSchema.safeParse({ memory: { nope: true } });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
  });
});

/**
 * Diagnostic verbosity is environment-only, and the schema is what enforces it.
 *
 * @remarks The reasoning is not tidiness. The workspace settings scope is a file
 * inside the agent's own working tree, so a settings block that set the log level
 * would let a run raise — or silence — its own record; the same argument keeps
 * `guard_mode` out of the server's run schema. Until now the rule was argued from
 * the keys appearing only in the environment schema, which is an absence, and an
 * absence stops being evidence the moment someone adds a block "for symmetry".
 *
 * The matching half — that a run request cannot carry one either — lives in
 * `@clarvis/loop`'s request-parsing suite, which is where `parseRunRequest` is
 * reachable from.
 */
describe("verbosity cannot be set from settings", () => {
  it.each([
    "log",
    "logging",
    "observability",
    "diagnostics",
    "CLARVIS_LOG",
    "CLARVIS_LOG_LEVEL",
    "CLARVIS_LOG_AUDIT",
  ])("kernelSettingsSchema rejects a top-level %s block", (key) => {
    const parsed = kernelSettingsSchema.safeParse({ default_model: "compat/m", [key]: "debug" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
  });

  it("no registered capability has quietly contributed one either", () => {
    const admitted = Object.keys(
      (kernelSettingsSchema as unknown as { shape: Record<string, unknown> }).shape,
    );
    expect(
      admitted.filter((k) => /^(log|logging|diagnostics|observability|verbos)/i.test(k)),
    ).toEqual([]);
    expect(admitted.filter((k) => k.startsWith("CLARVIS_"))).toEqual([]);
  });
});

describe("ConfigService.updateSettings over a registered capability block", () => {
  it("round-trips a workflows block to disk and back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-capset-"));
    const config = createConfigService(createFileConfigStore({ globalDir: dir }));

    const written = await config.updateSettings("global", workflowsBlock, null);
    expect(written.scopes.global?.workflows).toMatchObject({ max_concurrency: 8 });

    const onDisk = JSON.parse(readFileSync(globalPaths(dir).settingsFile, "utf8")) as Record<
      string,
      unknown
    >;
    expect(onDisk.workflows).toMatchObject({ max_concurrency: 8 });

    const reread = await createConfigService(
      createFileConfigStore({ globalDir: dir }),
    ).getSettings();
    expect(reread.scopes.global?.workflows).toMatchObject({ max_concurrency: 8 });
    expect(reread.merged.workflows).toMatchObject({ max_concurrency: 8 });
  });

  it("keeps an existing workflows block valid when an unrelated key is patched", async () => {
    const config = createConfigService(
      createMemoryConfigStore({ settings: { global: workflowsBlock } }),
    );
    const before = await config.getSettings();
    const revision = before.sources.find((source) => source.scope === "global")?.revision ?? null;
    const after = await config.updateSettings(
      "global",
      { default_reasoning_effort: "high" },
      revision,
    );
    expect(after.scopes.global?.workflows).toMatchObject({ max_concurrency: 8 });
    expect(after.scopes.global?.default_reasoning_effort).toBe("high");
  });
});
