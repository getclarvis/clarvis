import { expect, test } from "bun:test";
import { PLANS_DEFAULTS } from "@clarvis/kernel/config";
import type { Scope, SettingsAdapter } from "../../src/adapters/settings.ts";
import { seedPlansBlock } from "../../src/onboarding/seed-plans.ts";

function fakeSettings(opts: {
  files?: Partial<Record<Scope, Record<string, unknown>>>;
  corrupt?: Scope;
}): { settings: SettingsAdapter; writes: { scope: Scope; patch: unknown }[] } {
  const files = opts.files ?? {};
  const writes: { scope: Scope; patch: unknown }[] = [];
  const settings = {
    read: (scope: Scope) => files[scope],
    corrupt: (scope: Scope) => (opts.corrupt === scope ? "bad json" : null),
    effective: () => ({ ...files.global, ...files.workspace }),
    write: async (scope: Scope, patch: unknown) => {
      writes.push({ scope, patch });
    },
  } as unknown as SettingsAdapter;
  return { settings, writes };
}

test("seeds the product defaults into global settings on first use", async () => {
  const { settings, writes } = fakeSettings({ files: { global: { default_model: "x" } } });
  expect(await seedPlansBlock(settings)).toEqual({ seeded: true, scope: "global" });
  expect(writes).toEqual([{ scope: "global", patch: { plans: { ...PLANS_DEFAULTS } } }]);
  expect(PLANS_DEFAULTS).toMatchObject({ mode: "on", retention: "keep" });
});

test("seeds from a workspace-only settings file, still writing globally", async () => {
  const { settings, writes } = fakeSettings({ files: { workspace: { default_model: "x" } } });
  expect(await seedPlansBlock(settings)).toEqual({ seeded: true, scope: "global" });
  expect(writes).toHaveLength(1);
  expect(writes[0]!.scope).toBe("global");
});

test("never re-seeds over an explicit opt-out", async () => {
  const { settings, writes } = fakeSettings({ files: { global: { plans: { mode: "off" } } } });
  expect(await seedPlansBlock(settings)).toEqual({
    seeded: false,
    reason: "already-configured",
  });
  expect(writes).toEqual([]);
});

test("leaves an already-configured block alone", async () => {
  const { settings, writes } = fakeSettings({
    files: { global: { plans: { mode: "review", retention: "discard" } } },
  });
  expect(await seedPlansBlock(settings)).toEqual({
    seeded: false,
    reason: "already-configured",
  });
  expect(writes).toEqual([]);
});

test("does not conjure a settings file when none exists in either scope", async () => {
  const { settings, writes } = fakeSettings({});
  expect(await seedPlansBlock(settings)).toEqual({ seeded: false, reason: "no-settings-file" });
  expect(writes).toEqual([]);
});

test("refuses to write over a corrupt scope", async () => {
  const { settings, writes } = fakeSettings({
    files: { global: { default_model: "x" } },
    corrupt: "workspace",
  });
  expect(await seedPlansBlock(settings)).toEqual({ seeded: false, reason: "corrupt" });
  expect(writes).toEqual([]);
});
