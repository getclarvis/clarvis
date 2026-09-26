import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  createIsolationModeStore,
  isolationChoice,
  saveIsolationChoice,
  type IsolationChoice,
} from "../../src/adapters/isolation-mode.ts";
import type { SettingsAdapter } from "../../src/adapters/settings.ts";

test("workspace sandbox defaults keep network restricted", () => {
  expect(isolationChoice()).toEqual({
    mode: "sandbox",
    workspace: "read-write",
    network: "disabled",
  });
  expect(isolationChoice({ mode: "host", workspace: "read-only", network: "disabled" })).toEqual({
    mode: "host",
    workspace: "read-only",
    network: "disabled",
  });
});

test("a kernel write commits one dimension and preserves its siblings", async () => {
  const { store, dispose } = createRoot((dispose) => ({
    store: createIsolationModeStore(isolationChoice()),
    dispose,
  }));
  const global = {
    memory: { enabled: true },
    isolation: { mode: "host", workspace: "read-only", network: "enabled" } as IsolationChoice,
  };
  const settings = {
    read: () => global,
    write: async (scope: string, patch: { isolation: typeof global.isolation }) => {
      expect(scope).toBe("global");
      expect(patch.isolation).toEqual({
        mode: "host",
        workspace: "read-only",
        network: "disabled",
      });
      global.isolation = patch.isolation;
    },
  } as unknown as SettingsAdapter;

  await saveIsolationChoice(settings, store, { network: "disabled" });
  expect(store.choice()).toEqual(global.isolation);
  expect(global.memory.enabled).toBe(true);
  dispose();
});

test("a refused kernel write leaves the current radio unchanged", async () => {
  const { store, dispose } = createRoot((dispose) => ({
    store: createIsolationModeStore(isolationChoice({ mode: "sandbox" })),
    dispose,
  }));
  const settings = {
    read: () => ({ isolation: { mode: "sandbox" } }),
    write: async () => {
      throw new Error("refused");
    },
  } as unknown as SettingsAdapter;
  await expect(saveIsolationChoice(settings, store, { mode: "host" })).rejects.toThrow("refused");
  expect(store.choice().mode).toBe("sandbox");
  dispose();
});
