import { expect, test } from "bun:test";
import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import {
  compactKey,
  compactSequence,
  LAYER,
  PROMPT_EDITING_KEYS,
  promptKeyLabel,
  registerLevel,
  verb,
  type LevelSpec,
} from "../../src/ui/patterns/level-keys.ts";
import { glyph } from "../../src/theme/glyphs.ts";

function recordingKeymap(): {
  keymap: Keymap<Renderable, KeyEvent>;
  layers: { priority: number; keys: string[]; when?: string }[];
} {
  const layers: { priority: number; keys: string[]; when?: string }[] = [];
  const keymap = {
    registerLayer(layer: { priority: number; bindings?: { key: string }[]; when?: string }) {
      const entry = {
        priority: layer.priority,
        keys: (layer.bindings ?? []).map((b) => b.key),
        ...(layer.when === undefined ? {} : { when: layer.when }),
      };
      layers.push(entry);
      return () => {
        const i = layers.indexOf(entry);
        if (i >= 0) layers.splice(i, 1);
      };
    },
  } as unknown as Keymap<Renderable, KeyEvent>;
  return { keymap, layers };
}

test("LAYER: the named layers keep the app's priority ladder in order", () => {
  expect(LAYER).toEqual({
    INPUT: 500,
    LIST: 810,
    VITAL: 900,
    OVERLAY: 950,
    TRANSIENT: 955,
    MODAL: 960,
    CONFIRM: 970,
  });
  expect(LAYER.OVERLAY).toBeGreaterThan(LAYER.VITAL);
  expect(LAYER.CONFIRM).toBeGreaterThan(LAYER.MODAL);
  // A transient overlay floats over a mounted view, whose own escape sublayer
  // `registerLevel` lifts to OVERLAY + 1. It has to outrank that, and stay below
  // the modal an elicitation owns.
  expect(LAYER.TRANSIENT).toBeGreaterThan(LAYER.OVERLAY + 1);
  expect(LAYER.TRANSIENT).toBeLessThan(LAYER.MODAL);
});

test("registerLevel: a sub-overlay level's escape is bumped above the overlay host", () => {
  const { keymap, layers } = recordingKeymap();
  const spec: LevelSpec = { escape: { label: "back", run: () => {} } };
  registerLevel(keymap, spec);
  expect(layers).toEqual([{ priority: LAYER.OVERLAY + 1, keys: ["escape"] }]);
});

test("registerLevel: a level at OVERLAY or above keeps its own escape priority", () => {
  const { keymap, layers } = recordingKeymap();
  registerLevel(keymap, { escape: { label: "close", run: () => {} } }, LAYER.MODAL);
  expect(layers).toEqual([{ priority: LAYER.MODAL, keys: ["escape"] }]);
});

test("registerLevel: a scroll level binds scroll/page keys, not selection nav", () => {
  const { keymap, layers } = recordingKeymap();
  const spec: LevelSpec = {
    scroll: () => undefined,
    verbs: [verb("refresh", () => {})],
    escape: { label: "close" },
  };
  registerLevel(keymap, spec, LAYER.OVERLAY);
  const keys = layers.flatMap((l) => l.keys);
  for (const k of ["up", "down", "pageup", "pagedown"]) expect(keys).toContain(k);
  expect(keys).toContain("ctrl+r");
  expect(keys).not.toContain("home");
  expect(keys).not.toContain("end");
  for (const layer of layers) expect(layer.priority).toBe(LAYER.OVERLAY);
});

test("registerLevel: nav wins when a spec carries both nav and scroll", () => {
  const { keymap, layers } = recordingKeymap();
  registerLevel(keymap, {
    nav: { count: () => 3, index: () => 0, setIndex: () => {} },
    scroll: () => undefined,
  });
  const keys = layers.flatMap((l) => l.keys);
  expect(keys).toContain("home");
  expect(keys).toContain("end");
});

test("registerLevel: a retained page gates every owned key layer with its context", () => {
  const { keymap, layers } = recordingKeymap();
  registerLevel(
    keymap,
    {
      when: "overlay==plan",
      scroll: () => undefined,
      verbs: [verb("refresh", () => {})],
      escape: { label: "close", run: () => {} },
    },
    LAYER.OVERLAY,
  );
  expect(layers.length).toBeGreaterThan(1);
  expect(layers.every((layer) => layer.when === "overlay==plan")).toBe(true);
});

test("verb: derives the canonical key + label for a panel intention", () => {
  const runs: string[] = [];
  const del = verb("delete", () => runs.push("delete"));
  expect(del.key).toBe("d");
  expect(del.label).toBe("delete");
  del.run();
  expect(runs).toEqual(["delete"]);

  const gated = verb(
    "refresh",
    () => {},
    () => false,
  );
  expect(gated.key).toBe("ctrl+r");
  expect(gated.when!()).toBe(false);
});

test("compactKey: normalizes every modifier spelling to the compact form", () => {
  expect(compactKey("meta+r")).toBe("alt+r");
  expect(compactKey("alt+r")).toBe("alt+r");
  expect(compactKey("option+r")).toBe("alt+r");
  expect(compactKey("ctrl+o")).toBe("^o");
  expect(compactKey("cmd+s")).toBe("cmd+s");
  expect(compactKey("super+s")).toBe("super+s");
  expect(compactKey("super+s", { clientPlatform: "macos" })).toBe("cmd+s");
  expect(compactKey("meta+s", { clientPlatform: "macos" })).toBe("opt+s");
  expect(compactKey("ctrl+up")).toBe("ctrl+up");
  expect(compactKey("ctrl+down")).toBe("ctrl+down");
  expect(compactKey("ctrl+down")).not.toBe(compactKey("ctrl+v"));
  expect(compactKey("return")).toBe(glyph("return"));
  expect(compactKey("kpenter")).toBe(glyph("return"));
  expect(compactKey("escape")).toBe("esc");
  expect(compactKey("pageup")).toBe("pgup");
  expect(compactKey("shift+s")).toBe("S");
  expect(compactKey("shift+tab")).toBe("shift+tab");
});

test("compactKey: already-compact labels pass through unchanged (surfaces can re-format safely)", () => {
  for (const label of ["alt+r", "^o", "esc", "pgup", glyph("return"), "shift+tab", "@", "/diff"]) {
    expect(compactKey(label)).toBe(label);
  }
});

test("compactSequence joins each stroke of a chord through the formatter", () => {
  expect(compactSequence([{ display: "ctrl+x" }, { display: "meta+s" }])).toBe("^x alt+s");
});

test("PROMPT_EDITING_KEYS: dock rows carry prompt.* commands; promptKeyLabel dedupes aliases", () => {
  for (const row of PROMPT_EDITING_KEYS) {
    if (row.command) expect(row.command.startsWith("prompt.")).toBe(true);
    expect(row.keys.length).toBeGreaterThan(0);
    expect(row.desc.length).toBeGreaterThan(0);
  }
  expect(promptKeyLabel("prompt.send")).toBe(glyph("return"));
  expect(promptKeyLabel("prompt.newline")).toBe(`^j / shift+${glyph("return")}`);
  expect(promptKeyLabel("no.such.command")).toBe("");
});
