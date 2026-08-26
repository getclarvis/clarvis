import { expect, test } from "bun:test";
import type { SettingsAdapter } from "../../src/adapters/settings.ts";
import type { FieldEditor } from "../../src/views/config/view-host.tsx";
import { configuredModelRows } from "../../src/views/config/catalog-pick.ts";
import { modelPickerSpec } from "../../src/views/config/pick-model.ts";

const PROVIDERS = [
  {
    name: "openrouter",
    kind: "openai-compatible",
    models: { "glm-5.2": { context_window_tokens: 128000 } },
  },
];

function fakeSettings(providers: typeof PROVIDERS = PROVIDERS): SettingsAdapter {
  return { effective: () => ({ providers }) } as unknown as SettingsAdapter;
}

function fakeFe(): { fe: Pick<FieldEditor, "start">; calls: { label: string; current: string }[] } {
  const calls: { label: string; current: string }[] = [];
  const fe: Pick<FieldEditor, "start"> = {
    start: (label, current) => {
      calls.push({ label, current });
    },
  };
  return { fe, calls };
}

test("no providers, with a manual editor: falls back to manual entry and returns null", () => {
  const { fe, calls } = fakeFe();
  const commit: string[] = [];
  const spec = modelPickerSpec({
    fe,
    settings: fakeSettings([]),
    current: "openrouter/glm-5.2",
    commit: (v) => commit.push(v),
    close: () => {},
  });
  expect(spec).toBeNull();
  expect(calls).toEqual([{ label: "model (provider/modelId)", current: "openrouter/glm-5.2" }]);
});

test("no providers, no manual editor: calls onNoProviders and returns null", () => {
  let called = 0;
  const spec = modelPickerSpec({
    settings: fakeSettings([]),
    current: "",
    commit: () => {},
    close: () => {},
    onNoProviders: () => {
      called++;
    },
  });
  expect(spec).toBeNull();
  expect(called).toBe(1);
});

test("no providers, no manual editor, no onNoProviders: returns null without throwing", () => {
  expect(() =>
    modelPickerSpec({
      settings: fakeSettings([]),
      current: "",
      commit: () => {},
      close: () => {},
    }),
  ).not.toThrow();
});

test("providers present: returns a spec whose title and rows mirror configuredModelRows", () => {
  const spec = modelPickerSpec({
    settings: fakeSettings(),
    current: "openrouter/glm-5.2",
    commit: () => {},
    close: () => {},
  });
  expect(spec).not.toBeNull();
  expect(spec!.title).toContain("Pick a model");
  expect(spec!.rows()).toEqual(configuredModelRows(PROVIDERS, "openrouter/glm-5.2"));
});

test("providers present, no fe: the spec carries no onManual entry", () => {
  const spec = modelPickerSpec({
    settings: fakeSettings(),
    current: "",
    commit: () => {},
    close: () => {},
  });
  expect(spec!.onManual).toBeUndefined();
  expect("onManual" in spec!).toBe(false);
});

test("providers present, with fe: onManual closes the picker then opens the manual editor", () => {
  const { fe, calls } = fakeFe();
  let closed = 0;
  const spec = modelPickerSpec({
    fe,
    settings: fakeSettings(),
    current: "openrouter/glm-5.2",
    commit: () => {},
    close: () => {
      closed++;
    },
  });
  expect(spec!.onManual).toBeDefined();
  spec!.onManual!();
  expect(closed).toBe(1);
  expect(calls).toEqual([{ label: "model (provider/modelId)", current: "openrouter/glm-5.2" }]);
});

test("onPick closes the picker and commits the chosen id", () => {
  let closed = 0;
  const committed: string[] = [];
  const spec = modelPickerSpec({
    settings: fakeSettings(),
    current: "",
    commit: (v) => committed.push(v),
    close: () => {
      closed++;
    },
  });
  spec!.onPick("openrouter/glm-5.2");
  expect(closed).toBe(1);
  expect(committed).toEqual(["openrouter/glm-5.2"]);
});

test("onClose is the caller's close callback", () => {
  let closed = 0;
  const spec = modelPickerSpec({
    settings: fakeSettings(),
    current: "",
    commit: () => {},
    close: () => {
      closed++;
    },
  });
  spec!.onClose();
  expect(closed).toBe(1);
});
