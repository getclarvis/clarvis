import { expect, test } from "bun:test";
import type { Scope, SettingsAdapter } from "../../src/adapters/settings.ts";
import { seedBlockOnce } from "../../src/onboarding/seed-block-once.ts";

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

test("declines when the caller's own alreadyConfigured check says so", async () => {
  const { settings, writes } = fakeSettings({ files: { global: {} } });
  const outcome = await seedBlockOnce(settings, {
    alreadyConfigured: () => true,
    buildPatch: () => ({ example: { on: true } }),
  });
  expect(outcome).toEqual({ seeded: false, reason: "already-configured" });
  expect(writes).toEqual([]);
});

test("declines when either scope is corrupt", async () => {
  const { settings, writes } = fakeSettings({ files: { global: {} }, corrupt: "workspace" });
  const outcome = await seedBlockOnce(settings, {
    alreadyConfigured: () => false,
    buildPatch: () => ({ example: { on: true } }),
  });
  expect(outcome).toEqual({ seeded: false, reason: "corrupt" });
  expect(writes).toEqual([]);
});

test("declines when no settings.json exists in either scope", async () => {
  const { settings, writes } = fakeSettings({});
  const outcome = await seedBlockOnce(settings, {
    alreadyConfigured: () => false,
    buildPatch: () => ({ example: { on: true } }),
  });
  expect(outcome).toEqual({ seeded: false, reason: "no-settings-file" });
  expect(writes).toEqual([]);
});

test("writes the built patch to the global scope and reports it seeded", async () => {
  const { settings, writes } = fakeSettings({ files: { global: {} } });
  const outcome = await seedBlockOnce(settings, {
    alreadyConfigured: () => false,
    buildPatch: () => ({ example: { on: true } }),
  });
  expect(outcome).toEqual({ seeded: true, scope: "global" });
  expect(writes).toEqual([{ scope: "global", patch: { example: { on: true } } }]);
});

test("merges additionalOutcome fields into a successful outcome", async () => {
  const { settings } = fakeSettings({ files: { global: {} } });
  const outcome = await seedBlockOnce(settings, {
    alreadyConfigured: () => false,
    buildPatch: () => ({ example: { on: true } }),
    additionalOutcome: { count: 3 },
  });
  expect(outcome).toEqual({ seeded: true, scope: "global", count: 3 });
});
