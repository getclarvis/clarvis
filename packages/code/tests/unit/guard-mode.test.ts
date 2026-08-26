import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { GuardConfig } from "@clarvis/kernel/policy";
import { createGuardModeStore, type GuardMode } from "../../src/adapters/guard-mode.ts";

function makeDeps(opts: { codeDefault?: GuardMode; settingsGuard?: GuardConfig }): {
  deps: Parameters<typeof createGuardModeStore>[0];
} {
  return {
    deps: {
      code: {
        guardModeDefault: () => opts.codeDefault,
      },
      settingsGuard: () => opts.settingsGuard,
    },
  };
}

test("initial mode: code.json default wins over settings-derived", () => {
  createRoot((dispose) => {
    const { deps } = makeDeps({ codeDefault: "auto", settingsGuard: { type: "shell" } });
    expect(createGuardModeStore(deps).mode()).toBe("auto");
    dispose();
  });
});

test("initial mode: derives 'on' whether or not a settings guard block exists", () => {
  // An absent block means unconfigured, not disabled — the session opens with
  // the guard armed either way. Only an explicit `mode: "off"` disarms it, which
  // the next test pins.
  createRoot((dispose) => {
    expect(createGuardModeStore(makeDeps({ settingsGuard: { type: "shell" } }).deps).mode()).toBe(
      "on",
    );
    expect(createGuardModeStore(makeDeps({}).deps).mode()).toBe("on");
    dispose();
  });
});

test("initial mode: a guard.mode configured in settings.json wins over the presence default", () => {
  createRoot((dispose) => {
    expect(
      createGuardModeStore(
        makeDeps({ settingsGuard: { type: "shell", mode: "auto" } }).deps,
      ).mode(),
    ).toBe("auto");
    expect(
      createGuardModeStore(makeDeps({ settingsGuard: { type: "shell", mode: "off" } }).deps).mode(),
    ).toBe("off");
    dispose();
  });
});

test("cycle order is off → on → auto → off", () => {
  createRoot((dispose) => {
    const store = createGuardModeStore(
      makeDeps({ settingsGuard: { type: "shell", mode: "off" } }).deps,
    );
    expect(store.mode()).toBe("off");
    expect(store.cycle()).toBe("on");
    expect(store.cycle()).toBe("auto");
    expect(store.cycle()).toBe("off");
    expect(store.mode()).toBe("off");
    dispose();
  });
});

test("setMode is session-scoped", () => {
  createRoot((dispose) => {
    const { deps } = makeDeps({});
    const store = createGuardModeStore(deps);
    store.setMode("auto");
    expect(store.mode()).toBe("auto");
    dispose();
  });
});
