import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createMemoryModeStore } from "../../src/adapters/memory-mode.ts";

function makeDeps(opts: { settingsMemory?: { enabled?: boolean } }): {
  deps: Parameters<typeof createMemoryModeStore>[0];
} {
  return { deps: { settingsMemory: () => opts.settingsMemory } };
}

test("initial mode: settings memory block present derives 'on', absent derives 'off'", () => {
  createRoot((dispose) => {
    expect(createMemoryModeStore(makeDeps({ settingsMemory: {} }).deps).mode()).toBe("on");
    expect(createMemoryModeStore(makeDeps({}).deps).mode()).toBe("off");
    dispose();
  });
});

test("a memory block disabled in settings derives 'off' and reads as not configured", () => {
  createRoot((dispose) => {
    const store = createMemoryModeStore(makeDeps({ settingsMemory: { enabled: false } }).deps);
    expect(store.mode()).toBe("off");
    expect(store.configured()).toBe(false);
    dispose();
  });
});

test("configured() is true only when settings carry a live memory block", () => {
  createRoot((dispose) => {
    expect(createMemoryModeStore(makeDeps({ settingsMemory: {} }).deps).configured()).toBe(true);
    expect(createMemoryModeStore(makeDeps({}).deps).configured()).toBe(false);
    dispose();
  });
});

test("cycle toggles on ↔ off", () => {
  createRoot((dispose) => {
    const store = createMemoryModeStore(makeDeps({ settingsMemory: {} }).deps);
    expect(store.mode()).toBe("on");
    expect(store.cycle()).toBe("off");
    expect(store.cycle()).toBe("on");
    dispose();
  });
});

test("setMode is session-scoped", () => {
  createRoot((dispose) => {
    const { deps } = makeDeps({ settingsMemory: {} });
    const store = createMemoryModeStore(deps);
    store.setMode("off");
    expect(store.mode()).toBe("off");
    dispose();
  });
});

test("refresh() makes configured() see a settings change (non-reactive files bridge)", () => {
  createRoot((dispose) => {
    let block: { enabled?: boolean } | undefined = undefined;
    const store = createMemoryModeStore({
      settingsMemory: () => block,
    });
    expect(store.configured()).toBe(false);
    block = {};
    store.refresh();
    expect(store.configured()).toBe(true);
    dispose();
  });
});
