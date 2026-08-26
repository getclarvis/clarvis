import { expect, test } from "bun:test";
import type { Scope, SettingsAdapter } from "../../src/adapters/settings.ts";
import { seedMemoryBlock } from "../../src/onboarding/seed-memory.ts";

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

test("turns memory on in global settings on first use", async () => {
  const { settings, writes } = fakeSettings({ files: { global: { default_model: "x" } } });
  expect(await seedMemoryBlock(settings)).toEqual({ seeded: true, scope: "global" });
  expect(writes).toEqual([{ scope: "global", patch: { memory: { enabled: true } } }]);
});

test("omits model so the block inherits default_model", async () => {
  const { settings, writes } = fakeSettings({ files: { global: { default_model: "x" } } });
  await seedMemoryBlock(settings);
  const patch = writes[0]!.patch as { memory: Record<string, unknown> };
  expect(Object.keys(patch.memory)).toEqual(["enabled"]);
});

test("seeds from a workspace-only settings file, still writing globally", async () => {
  const { settings, writes } = fakeSettings({ files: { workspace: { default_model: "x" } } });
  expect(await seedMemoryBlock(settings)).toEqual({ seeded: true, scope: "global" });
  expect(writes).toHaveLength(1);
  expect(writes[0]!.scope).toBe("global");
});

test("never re-seeds over an explicit opt-out", async () => {
  const { settings, writes } = fakeSettings({ files: { global: { memory: { enabled: false } } } });
  expect(await seedMemoryBlock(settings)).toEqual({
    seeded: false,
    reason: "already-configured",
  });
  expect(writes).toEqual([]);
});

test("leaves an already-configured block alone", async () => {
  const { settings, writes } = fakeSettings({
    files: { global: { memory: { enabled: true, model: "cheap-model" } } },
  });
  expect(await seedMemoryBlock(settings)).toEqual({
    seeded: false,
    reason: "already-configured",
  });
  expect(writes).toEqual([]);
});

test("does not conjure a settings file when none exists in either scope", async () => {
  const { settings, writes } = fakeSettings({});
  expect(await seedMemoryBlock(settings)).toEqual({ seeded: false, reason: "no-settings-file" });
  expect(writes).toEqual([]);
});

test("refuses to write over a corrupt scope", async () => {
  const { settings, writes } = fakeSettings({
    files: { global: { default_model: "x" } },
    corrupt: "workspace",
  });
  expect(await seedMemoryBlock(settings)).toEqual({ seeded: false, reason: "corrupt" });
  expect(writes).toEqual([]);
});
