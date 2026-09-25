import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createMemoryModeStore, saveMemoryMode } from "../../src/adapters/memory-mode.ts";
import type { SettingsAdapter } from "../../src/adapters/settings.ts";

test("memory starts off on a fresh installation and accepts a saved choice", () => {
  createRoot((dispose) => {
    const store = createMemoryModeStore();
    expect(store.mode()).toBe("off");
    expect(store.cycle()).toBe("on");
    store.setMode("off");
    expect(store.mode()).toBe("off");
    expect(createMemoryModeStore("on").mode()).toBe("on");
    dispose();
  });
});

test("saving On persists the global choice and preserves global memory configuration", async () => {
  const { store, dispose } = createRoot((dispose) => ({
    store: createMemoryModeStore(),
    dispose,
  }));
  let saved: unknown;
  const settings = {
    read: () => ({ memory: { provider: { kind: "wiki" }, enabled: false } }),
    write: async (scope: string, patch: unknown) => {
      expect(scope).toBe("global");
      saved = patch;
    },
  } as unknown as SettingsAdapter;

  await saveMemoryMode(settings, store, "on");
  expect(saved).toEqual({ memory: { provider: { kind: "wiki" }, enabled: true } });
  expect(store.mode()).toBe("on");
  await saveMemoryMode(settings, store, "off");
  expect(saved).toEqual({ memory: { provider: { kind: "wiki" }, enabled: false } });
  expect(store.mode()).toBe("off");
  dispose();
});

test("a rejected save leaves the previous choice active", async () => {
  const { store, dispose } = createRoot((dispose) => ({
    store: createMemoryModeStore("on"),
    dispose,
  }));
  const settings = {
    read: () => ({}),
    write: async () => {
      throw new Error("write failed");
    },
  } as unknown as SettingsAdapter;

  await expect(saveMemoryMode(settings, store, "off")).rejects.toThrow("write failed");
  expect(store.mode()).toBe("on");
  dispose();
});
