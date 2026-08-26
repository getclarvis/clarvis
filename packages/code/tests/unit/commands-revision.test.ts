import { describe, expect, test } from "bun:test";
import { createMemo, createRoot } from "solid-js";
import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import {
  createCommands,
  type CommandEffects,
  type Commands,
  type CommandUi,
} from "../../src/keys/commands.ts";
import type { Interaction } from "../../src/keys/interaction.ts";

function harness(): Commands {
  const effects: CommandEffects = {
    clearSession: () => {},
    status: () => {},
    exportSession: () => {},
  };
  const ui: CommandUi = { openView: () => {}, dismiss: () => {}, commandFailed: () => {} };
  const layers: unknown[] = [];
  const keymap = {
    registerLayer(layer: unknown) {
      layers.push(layer);
      return () => {
        const i = layers.indexOf(layer);
        if (i >= 0) layers.splice(i, 1);
      };
    },
    runCommand: () => ({ ok: false }),
    getCommandBindings: () => new Map(),
    getCommandEntries: () => [],
    setData: () => {},
    getData: () => undefined,
    acquireResource: (_key: unknown, make: () => unknown) => make(),
  } as unknown as Keymap<Renderable, KeyEvent>;
  return createCommands({ keymap } as unknown as Interaction, effects, ui);
}

describe("the command registry's revision signal", () => {
  test("bumps when a command is registered and when it is removed", () => {
    createRoot((dispose) => {
      const commands = harness();
      const start = commands.revision();
      const off = commands.skillCommand(
        "my-skill",
        { name: "my-skill", description: "d", arguments: [{ name: "target" }] },
        () => {},
      );
      const afterAdd = commands.revision();
      expect(afterAdd).toBeGreaterThan(start);
      off();
      expect(commands.revision()).toBeGreaterThan(afterAdd);
      dispose();
    });
  });

  test("a memo over the registry sees commands registered after it was built", () => {
    createRoot((dispose) => {
      const commands = harness();
      /**
       * The shape `App.tsx` uses for the autocomplete provider list. Without the
       * `revision()` read this memo has no reactive source at all — the registry
       * is a plain `Map` — so it would compute once and never see the skills and
       * MCP prompts that register asynchronously after the client connects.
       */
      const slashes = createMemo(() => {
        commands.revision();
        return commands.entries().flatMap((e) => e.slashes);
      });

      expect(slashes()).not.toContain("/my-skill");
      commands.skillCommand(
        "my-skill",
        { name: "my-skill", description: "d", arguments: [{ name: "target" }] },
        () => {},
      );
      expect(slashes()).toContain("/my-skill");
      dispose();
    });
  });

  test("an unregistered command leaves the memo again", () => {
    createRoot((dispose) => {
      const commands = harness();
      const slashes = createMemo(() => {
        commands.revision();
        return commands.entries().flatMap((e) => e.slashes);
      });
      const off = commands.skillCommand("gone", { name: "gone" }, () => {});
      expect(slashes()).toContain("/gone");
      off();
      expect(slashes()).not.toContain("/gone");
      dispose();
    });
  });
});
