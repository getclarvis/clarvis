import { expect, test } from "bun:test";
import type { CodeConfigStore } from "../../src/adapters/code-config.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import type {
  KeyboardConfig,
  KeyboardEnvironment,
  KeyboardEnvironmentConfig,
  KeyboardProfile,
} from "../../src/keys/keyboard-profile.ts";
import { uiCommand } from "../../src/keys/actions.ts";
import { KeyboardView } from "../../src/views/config/KeyboardView.tsx";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { openRender } from "../helpers/tracked-render.ts";

const ENVIRONMENT_ID = "0123456789abcdef01234567";

function mount(seed: { profile?: KeyboardProfile; bindings?: Record<string, string[]> } = {}) {
  const { keymap, press } = createFakeKeymap();
  keymap.registerLayer({
    priority: 0,
    commands: [
      uiCommand({
        id: "settings.open",
        title: "Open settings",
        description: "Open the settings hub",
        category: "navigation",
        surfaces: ["full-help"],
        run: () => {},
      }),
    ],
    bindings: [],
  });

  const environment: KeyboardEnvironment = {
    transport: "ssh",
    runtimePlatform: "linux",
    terminal: { name: "xterm-256color" },
    protocol: "legacy",
    multiplexer: "tmux",
    modifiers: {
      ctrl: "supported",
      shift: "supported",
      meta: "unknown",
      super: "unknown",
      hyper: "unknown",
    },
    baseLayout: "unknown",
    profile: seed.profile ?? "portable",
  };
  const interaction = {
    keymap,
    keyboardEnvironment: () => environment,
    keyboardEnvironmentId: () => ENVIRONMENT_ID,
  } as unknown as Interaction;
  const closed: boolean[] = [];
  const { host, controls } = createViewHost({
    interaction,
    close: () => closed.push(true),
    dispatch: () => {},
  });

  let config: KeyboardConfig = {
    version: 1,
    environments: {
      [ENVIRONMENT_ID]: {
        profile: seed.profile ?? "portable",
        ...(seed.bindings ? { bindings: seed.bindings } : {}),
      },
    },
  };
  const writes: Array<KeyboardEnvironmentConfig | undefined> = [];
  const code = {
    keyboardConfig: () => config,
    writeKeyboardEnvironment: (id: string, value: KeyboardEnvironmentConfig | undefined) => {
      expect(id).toBe(ENVIRONMENT_ID);
      writes.push(value);
      const environments = { ...config.environments };
      if (value) environments[id] = value;
      else delete environments[id];
      config = { version: 1, environments };
    },
  } as CodeConfigStore;
  const notices: string[] = [];

  return { closed, code, controls, host, notices, press, writes };
}

test("keyboard settings selects profiles, cycles the client convention, and resets", async () => {
  const mounted = mount();
  const t = await openRender(
    (() =>
      KeyboardView(mounted.host, {
        code: mounted.code,
        notify: (message) => mounted.notices.push(message),
      })) as never,
    { width: 110, height: 28 },
  );
  await t.renderOnce();
  await t.renderOnce();

  const frame = t.captureCharFrame();
  expect(frame).toContain("Keyboard");
  expect(frame).toContain("Terminal: xterm-256color");
  expect(frame).toContain("Protocol: legacy");
  expect(frame).toContain("Transport: ssh");
  expect(frame).toContain("Multiplexer: tmux");
  expect(frame).toContain("Client convention: unknown");
  expect(frame).toContain("Portable");

  mounted.press("down");
  mounted.press("return");
  expect(mounted.writes.at(-1)).toMatchObject({ profile: "enhanced" });
  expect(mounted.notices.at(-1)).toBe("keyboard profile: enhanced");

  mounted.press("c");
  expect(mounted.writes.at(-1)).toMatchObject({ clientPlatform: "macos" });

  mounted.press("x");
  expect(mounted.writes.at(-1)).toBeUndefined();
  expect(mounted.notices.at(-1)).toBe("keyboard profile reset to automatic");

  mounted.press("escape");
  expect(mounted.closed).toEqual([true]);
  mounted.controls.dispose();
  t.renderer.destroy();
});

test("manual bindings shows stable commands and enters and leaves the shared editor", async () => {
  const mounted = mount();
  const t = await openRender(
    (() =>
      KeyboardView(mounted.host, {
        code: mounted.code,
        notify: (message) => mounted.notices.push(message),
      })) as never,
    { width: 110, height: 28 },
  );
  await t.renderOnce();
  await t.renderOnce();

  mounted.press("b");
  await t.renderOnce();
  let frame = t.captureCharFrame();
  expect(frame).toContain("Open settings");
  expect(frame).toContain("no shortcut");

  mounted.press("return");
  await t.renderOnce();
  frame = t.captureCharFrame();
  expect(frame).toContain("bindings");

  mounted.press("escape");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Open settings");

  mounted.press("escape");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Portable");

  mounted.controls.dispose();
  t.renderer.destroy();
});

test("a stored override is presented as active only under the manual profile", async () => {
  const mounted = mount({ profile: "manual", bindings: { "settings.open": ["f8"] } });
  const t = await openRender(
    (() =>
      KeyboardView(mounted.host, {
        code: mounted.code,
        notify: (message) => mounted.notices.push(message),
      })) as never,
    { width: 110, height: 28 },
  );
  await t.renderOnce();
  mounted.press("b");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Open settings");
  expect(frame).not.toContain("stored but inactive");
  expect(frame).not.toContain("(off)");
  mounted.controls.dispose();
  t.renderer.destroy();
});

test("a stored override under another profile is marked off rather than shown as active", async () => {
  // `configureKeyboard` applies the bindings map only under `manual`, so a stored
  // override is dead weight under any other profile. Colouring it as an active
  // override is how a user came to believe bindings were in force that nothing
  // had installed.
  const mounted = mount({ profile: "portable", bindings: { "settings.open": ["f8"] } });
  const t = await openRender(
    (() =>
      KeyboardView(mounted.host, {
        code: mounted.code,
        notify: (message) => mounted.notices.push(message),
      })) as never,
    { width: 110, height: 28 },
  );
  await t.renderOnce();
  mounted.press("b");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("1 override stored but inactive");
  expect(frame).toContain("only under the Manual profile");
  expect(frame).toContain("f8 (off)");
  mounted.controls.dispose();
  t.renderer.destroy();
});

test("the diagnostic saves its verdicts without switching a manual profile off", async () => {
  // Overwriting an explicit `manual` with the recommendation deactivated every
  // override the user authored while leaving the now-dead map on disk, and
  // nothing said so.
  const mounted = mount({ profile: "manual", bindings: { "settings.open": ["f8"] } });
  const t = await openRender(
    (() =>
      KeyboardView(mounted.host, {
        code: mounted.code,
        notify: (message) => mounted.notices.push(message),
      })) as never,
    { width: 110, height: 28 },
  );
  await t.renderOnce();
  mounted.press("d");
  await t.renderOnce();
  const diagnostic = t.captureCharFrame();
  expect(diagnostic).toContain("Keyboard diagnostic");
  expect(diagnostic).toContain("Option is text");
  expect(diagnostic).toContain("Meta/Esc+");
  for (let probe = 0; probe < 4; probe++) mounted.press("u");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Diagnostic complete.");
  mounted.press("s");
  expect(mounted.writes.at(-1)).toMatchObject({
    profile: "manual",
    bindings: { "settings.open": ["f8"] },
    verdicts: { ctrl: "unsupported", meta: "unsupported" },
  });
  expect(mounted.notices.at(-1)).toContain("manual bindings kept");
  expect(mounted.notices.at(-1)).toContain("recommended: portable");
  mounted.controls.dispose();
  t.renderer.destroy();
});

test("the diagnostic does apply its recommendation when no manual profile is set", async () => {
  const mounted = mount({ profile: "portable" });
  const t = await openRender(
    (() =>
      KeyboardView(mounted.host, {
        code: mounted.code,
        notify: (message) => mounted.notices.push(message),
      })) as never,
    { width: 110, height: 28 },
  );
  await t.renderOnce();
  mounted.press("d");
  await t.renderOnce();
  for (let probe = 0; probe < 4; probe++) mounted.press("u");
  mounted.press("s");
  expect(mounted.writes.at(-1)).toMatchObject({ profile: "portable" });
  expect(mounted.notices.at(-1)).toBe("keyboard diagnostic saved: portable");
  mounted.controls.dispose();
  t.renderer.destroy();
});
