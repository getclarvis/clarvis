import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { createTestKeymap } from "@opentui/keymap/testing";
import { Help } from "../../src/views/overlays/Help.tsx";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { CommandEntryView } from "../../src/keys/commands.ts";
import { registerUiActionFields, uiCommand } from "../../src/keys/actions.ts";
import { registerWhenField } from "../../src/keys/when-dsl.ts";
import { LAYER } from "../../src/keys/keyspec.ts";

function fakeInteraction(): { interaction: Interaction; cleanup(): void } {
  const harness = createTestKeymap({ defaultKeys: true });
  const keymap = harness.keymap as unknown as Interaction["keymap"];
  const offFields = registerUiActionFields(keymap);
  const offWhen = registerWhenField(keymap);
  // `ui.openView` pushes the `view` overlay context, so this is the context every
  // reader of `/help` is actually in.
  keymap.setData("overlay", "view");
  const offActions = keymap.registerLayer({
    commands: [
      uiCommand({
        id: "run.cancel",
        title: "Cancel run",
        description: "Cancel the current run",
        category: "run",
        surfaces: ["footer", "full-help"],
        footerLabel: "cancel",
        hintPriority: 90,
        hintGroup: "escape",
        run: () => {},
      }),
      uiCommand({
        id: "prompt.send",
        title: "Send prompt",
        description: "Send the current prompt",
        category: "prompt",
        surfaces: ["full-help"],
        run: () => {},
      }),
      uiCommand({
        id: "prompt.newline",
        title: "Insert newline",
        description: "Insert a newline",
        category: "prompt",
        surfaces: ["full-help"],
        run: () => {},
      }),
    ],
    bindings: [
      { key: "ctrl+c", cmd: "run.cancel" },
      { key: "return", cmd: "prompt.send" },
      { key: "ctrl+j", cmd: "prompt.newline" },
      { key: "shift+return", cmd: "prompt.newline" },
    ],
  });
  const offGated = keymap.registerLayer({
    priority: LAYER.VITAL,
    commands: [
      uiCommand({
        id: "transcript.toggleCollapse",
        title: "Expand / collapse blocks",
        description: "Toggle the focused block, else all collapsible blocks",
        category: "view",
        surfaces: ["footer", "full-help"],
        footerLabel: "expand",
        hintPriority: 50,
        hintGroup: "primary",
        run: () => {},
      }),
    ],
    bindings: [{ key: "ctrl+o", cmd: "transcript.toggleCollapse", when: "overlay==none" }],
  });
  return {
    interaction: {
      keymap,
      renderer: { useMouse: true },
      keyboardEnvironment: () => ({
        transport: "ssh",
        runtimePlatform: "linux",
        terminal: { name: "xterm" },
        protocol: "legacy",
        multiplexer: "tmux",
        modifiers: {
          ctrl: "unknown",
          shift: "unknown",
          meta: "unknown",
          super: "unknown",
          hyper: "unknown",
        },
        baseLayout: "unknown",
        profile: "portable",
      }),
    } as unknown as Interaction,
    cleanup: () => {
      offGated();
      offActions();
      offWhen();
      offFields();
      harness.cleanup();
    },
  };
}

const ENTRIES: CommandEntryView[] = [
  {
    name: "help.open",
    title: "Help",
    desc: "Keybindings and commands",
    category: "view",
    slashes: ["/help", "/commands"],
    surface: "slash",
    group: "actions",
    args: [],
    subcommands: [],
    keyHint: "",
  },
  {
    name: "settings.open",
    title: "Settings",
    desc: "Configuration hub",
    category: "view",
    slashes: ["/settings"],
    surface: "slash",
    group: "navigate",
    args: [],
    subcommands: [{ name: "providers", desc: "Providers" }],
    keyHint: "",
  },
  {
    name: "providers.open",
    title: "Providers",
    desc: "Edit providers, credentials and per-model windows",
    category: "view",
    slashes: [],
    surface: "internal",
    group: "navigate",
    parent: "settings",
    args: [],
    subcommands: [],
    keyHint: "",
  },
  {
    name: "skill.review-diff",
    title: "review-diff",
    desc: "Review a diff.",
    category: "action",
    slashes: ["/review-diff"],
    surface: "slash",
    group: "skills",
    args: [],
    subcommands: [],
    keyHint: "",
  },
  {
    name: "figma:inspect",
    title: "inspect",
    desc: "Inspect a node.",
    category: "action",
    slashes: ["/figma:inspect"],
    surface: "slash",
    group: "mcp",
    args: [],
    subcommands: [],
    keyHint: "",
  },
];

async function frame(): Promise<string> {
  const fake = fakeInteraction();
  const t = await openRender(
    (() => <Help interaction={fake.interaction} entries={() => ENTRIES} />) as never,
    { width: 110, height: 64 },
  );
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  fake.cleanup();
  return out;
}

test("help projects active actions, destinations and environment without duplicate legends", async () => {
  const out = await frame();
  expect(out).toContain("Available here");
  expect(out).toContain("Cancel the current run");
  expect(out).toContain("[^c]");
  expect(out).toContain("Go to");
  expect(out).toContain("Settings");
  expect(out).toContain("settings > Providers");
  expect(out).toContain("Editing");
  expect(out).toContain("Send the current prompt");
  expect(out).toContain("[^j] / [shift+↵]");
  expect(out).toContain("Insert a newline");
  expect(out).toContain("Input syntax");
  expect(out).toContain("Keyboard environment");
  expect(out).toContain("portable");
  expect(out).toContain("ssh · legacy · tmux");
  expect(out).toContain("Settings > Keyboard");
  expect(out).toContain("Mouse");
  expect(out).not.toContain("Config panels");
  expect(out).not.toContain("During a run");
});

test("help documents the global keys its own overlay deactivates", async () => {
  // `/help` is a view overlay, so every binding gated on `overlay==none` is
  // inactive for exactly as long as the reader is looking at the reference — and
  // "Available here" is projected from *active* keys. Without a registered-
  // visibility section the one screen whose purpose is the key reference listed
  // none of the app's global keys.
  const out = await frame();
  expect(out).toContain("Available elsewhere");
  expect(out).toContain("Toggle the focused block, else all collapsible blocks");
  expect(out).toContain("[^o]");
  // ...and it does not repeat what is active right here.
  const elsewhereBlock = out.slice(out.indexOf("Available elsewhere"));
  expect(elsewhereBlock).not.toContain("Cancel the current run");
});
