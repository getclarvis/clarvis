import { expect, spyOn, test } from "bun:test";
import { KeyEvent, type CliRenderer } from "@opentui/core";
import { openCoreRenderer } from "../helpers/tracked-core-render.ts";
import {
  buildVitalBindings,
  createInteraction,
  DEFAULT_BINDING_CANDIDATES,
  DEFAULT_WHEN,
  resolvedVitalBindings,
  type InteractionEffects,
} from "../../src/keys/interaction.ts";
import {
  buildKeyboardEnvironment,
  type KeyboardEnvironment,
  type KeyboardProfile,
} from "../../src/keys/keyboard-profile.ts";
import type { Platform } from "../../src/adapters/platform.ts";
import { uiCommand } from "../../src/keys/actions.ts";

const find = (bindings: ReturnType<typeof buildVitalBindings>, cmd: string) =>
  bindings.filter((b) => b.cmd === cmd);

process.setMaxListeners(50);

function press(renderer: CliRenderer, name: string, mods: Partial<KeyEvent> = {}): void {
  renderer.keyInput.emit(
    "keypress",
    new KeyEvent({
      name,
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      ...mods,
    } as ConstructorParameters<typeof KeyEvent>[0]),
  );
}

function fakeEffects(overrides: Partial<InteractionEffects> = {}): InteractionEffects & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    cancelRun: () => {
      calls.push("cancelRun");
      return false;
    },
    clearInputDraft: () => {
      calls.push("clearInputDraft");
    },
    quit: (opts) => {
      calls.push(`quit:${JSON.stringify(opts)}`);
    },
    dismissTopOverlay: () => {
      calls.push("dismissTopOverlay");
      return false;
    },
    isRunActive: () => false,
    isDraftNonEmpty: () => false,
    hint: (m) => {
      calls.push(`hint:${m}`);
    },
    openAgentPicker: () => {
      calls.push("openAgentPicker");
    },
    openIsolationPicker: () => {
      calls.push("openIsolationPicker");
    },
    openReviewPicker: () => {
      calls.push("openReviewPicker");
    },
    focusNext: () => {
      calls.push("focusNext");
    },
    toggleExpandAll: () => {
      calls.push("toggleExpandAll");
    },
    openDiff: () => {
      calls.push("openDiff");
    },
    openPlan: () => {
      calls.push("openPlan");
    },
    focusBlock: (d) => {
      calls.push(`focusBlock:${d}`);
    },
    clearBlockFocus: () => {
      calls.push("clearBlockFocus");
      return false;
    },
    scrollTranscript: (r) => {
      calls.push(`scrollTranscript:${r}`);
    },
    loadEarlier: () => {
      calls.push("loadEarlier");
    },
    ...overrides,
  };
}

function fakePlatform(): Platform & { suspendCalls: number; resumeCalls: number } {
  const p = {
    suspendCalls: 0,
    resumeCalls: 0,
    capabilities: {
      revision: () => 0,
      keyboard: () => "kitty" as const,
      remote: () => false,
      runtimePlatform: () => "linux" as const,
      terminal: () => ({ name: "test-kitty" }),
      multiplexer: () => "none",
    },
    suspend: () => {
      p.suspendCalls += 1;
    },
    resume: () => {
      p.resumeCalls += 1;
    },
  };
  return p as unknown as Platform & { suspendCalls: number; resumeCalls: number };
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

/**
 * The environment a given profile resolves candidates against.
 *
 * @remarks Built through the real {@link buildKeyboardEnvironment}, so a test
 *   asserting a default key is asserting the table the app actually installs.
 *   The predecessor of these tests read a second, hand-written copy of the
 *   binding table that nothing in `src` consumed, so it stayed green while the
 *   live candidates drifted out from under it.
 */
function environmentFor(profile: KeyboardProfile): KeyboardEnvironment {
  return buildKeyboardEnvironment(
    {
      remote: false,
      runtimePlatform: "linux",
      terminal: { name: "test-kitty" },
      kittyKeyboard: true,
      multiplexer: "none",
      host: {
        platform: "linux",
        primaryModifier: "ctrl",
        modifiers: {
          ctrl: "supported",
          shift: "supported",
          meta: "supported",
          super: "supported",
          hyper: "supported",
        },
      },
    },
    { profile },
  );
}

const portable = (): Record<string, string | string[]> =>
  resolvedVitalBindings("linux", environmentFor("portable"));
const enhanced = (): Record<string, string | string[]> =>
  resolvedVitalBindings("linux", environmentFor("enhanced"));

test("ctrl+z binds to app.suspend off Windows, and the binding is withheld along with the command on Windows", () => {
  // app.suspend is never registered as a command on win32 (no SIGTSTP, no job
  // control to return from). If the binding stayed while the command didn't,
  // ctrl+z would point at nothing and the keymap's own unresolved-command
  // warning would fire on every Windows boot.
  expect(resolvedVitalBindings("linux", environmentFor("portable"))["app.suspend"]).toBe("ctrl+z");
  expect(resolvedVitalBindings("win32", environmentFor("portable"))["app.suspend"]).toBeUndefined();
});

test("the four rebindable transcript.scroll* commands resolve, page keys on every profile", () => {
  expect(portable()["transcript.scrollPageUp"]).toBe("pageup");
  expect(portable()["transcript.scrollPageDown"]).toBe("pagedown");
  expect(enhanced()["transcript.scrollLineUp"]).toBe("alt+up");
  expect(enhanced()["transcript.scrollLineDown"]).toBe("alt+down");
});

test("modified arrows stay portable — they are plain xterm, not an enhanced capability", () => {
  expect(portable()["transcript.focusPrev"]).toBe("ctrl+up");
  expect(portable()["transcript.focusNext"]).toBe("ctrl+down");
});

test("Ctrl+O toggles expand/collapse (copy-mode's Alt+C is gone) and is overlay-gated", () => {
  expect(portable()["transcript.toggleCollapse"]).toBe("ctrl+o");
  expect(DEFAULT_BINDING_CANDIDATES["transcript.copyMode"]).toBeUndefined();
  const [b] = find(buildVitalBindings(portable(), DEFAULT_WHEN), "transcript.toggleCollapse");
  expect(b?.when).toBe("overlay==none");
});

test("Ctrl+P toggles the plan; enhanced terminals also retain Alt+P", () => {
  expect(portable()["plan.open"]).toBe("ctrl+p");
  expect(new Set(enhanced()["plan.open"])).toEqual(new Set(["ctrl+p", "alt+p"]));
  for (const binding of find(buildVitalBindings(enhanced(), DEFAULT_WHEN), "plan.open"))
    expect(binding.when).toBe("overlay in (none, plan)");
  expect(DEFAULT_BINDING_CANDIDATES["memory.cycle"]).toBeUndefined();
  expect(DEFAULT_WHEN["memory.cycle"]).toBeUndefined();
});

test("Isolation and review have portable Ctrl keys plus enhanced Alt keys", () => {
  expect(portable()["isolation.picker"]).toBe("ctrl+s");
  expect(enhanced()["isolation.picker"]).toEqual(["alt+s", "ctrl+s"]);
  expect(portable()["review.picker"]).toBe("ctrl+g");
  expect(enhanced()["review.picker"]).toEqual(["alt+g", "ctrl+g"]);
  for (const binding of find(buildVitalBindings(enhanced(), DEFAULT_WHEN), "isolation.picker"))
    expect(binding.when).toBe("overlay==none");
});

test("F1 has no built-in action", async () => {
  expect(Object.values(portable()).flat()).not.toContain("f1");
  expect(Object.values(enhanced()).flat()).not.toContain("f1");
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects();
  createInteraction(t.renderer, fakePlatform(), effects);
  press(t.renderer, "f1");
  await settle();
  expect(effects.calls).toEqual([]);
  t.renderer.destroy();
});

test("background commands are gated to overlay==none so the active window owns its keys", () => {
  const vital = buildVitalBindings(enhanced(), DEFAULT_WHEN);
  for (const cmd of Object.keys(DEFAULT_WHEN).filter((name) => name !== "plan.open")) {
    const [b] = find(vital, cmd);
    expect(b?.when).toBe("overlay==none");
  }
  expect(find(vital, "run.cancel")[0]?.when).toBeUndefined();
  for (const cmd of ["agent.picker", "isolation.picker", "review.picker"])
    expect(find(vital, cmd)[0]?.when).toBe("overlay==none");
  expect(find(vital, "plan.open")[0]?.when).toBe("overlay in (none, plan)");
});

test("a pending modal keeps scrolling, suspend and cancel, and withholds the rest", () => {
  // The modal's own layer owns navigation and mutation keys and projects its own
  // actions, but a user answering a guard prompt still has to be able to scroll
  // back to what the agent asked about, suspend, and get out.
  const vital = buildVitalBindings(enhanced(), DEFAULT_WHEN);
  const modalOf = (cmd: string): unknown => find(vital, cmd)[0]?.modal;
  for (const cmd of [
    "run.cancel",
    "app.suspend",
    "transcript.scrollPageUp",
    "transcript.scrollPageDown",
    "transcript.scrollLineUp",
    "transcript.scrollLineDown",
  ]) {
    expect(modalOf(cmd), `${cmd} must survive a modal`).toBeUndefined();
  }
  for (const cmd of [
    "app.escape",
    "agent.picker",
    "isolation.picker",
    "review.picker",
    "transcript.toggleCollapse",
    "transcript.focusPrev",
  ]) {
    expect(modalOf(cmd), `${cmd} must be withheld under a modal`).toBe("none");
  }
});

test("manual profiles can bind any registered stable command, while other profiles ignore overrides", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const interaction = createInteraction(t.renderer, fakePlatform(), fakeEffects());
  let calls = 0;
  const off = interaction.keymap.registerLayer({
    commands: [
      uiCommand({
        id: "custom.destination",
        title: "Custom destination",
        description: "Open a custom destination",
        category: "navigation",
        surfaces: ["full-help"],
        run: () => {
          calls += 1;
        },
      }),
    ],
  });
  const id = interaction.keyboardEnvironmentId();
  interaction.configureKeyboard({
    version: 1,
    environments: {
      [id]: { profile: "manual", bindings: { "custom.destination": ["f8"] } },
    },
  });
  press(t.renderer, "f8");
  await settle();
  expect(calls).toBe(1);

  interaction.configureKeyboard({
    version: 1,
    environments: {
      [id]: { profile: "enhanced", bindings: { "custom.destination": ["f8"] } },
    },
  });
  press(t.renderer, "f8");
  await settle();
  expect(calls).toBe(1);
  off();
  t.renderer.destroy();
});

test("createInteraction: run.cancel — cancelRun() true disarms silently, no hint/quit", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects({
    isRunActive: () => true,
    cancelRun: () => (effects.calls.push("cancelRun"), true),
  });
  createInteraction(t.renderer, fakePlatform(), effects);
  press(t.renderer, "c", { ctrl: true });
  await settle();
  expect(effects.calls).toEqual(["cancelRun"]);
  t.renderer.destroy();
});

test("createInteraction: run.cancel — a non-empty draft does not intercept the quit path", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects({ isDraftNonEmpty: () => true });
  createInteraction(t.renderer, fakePlatform(), effects);
  press(t.renderer, "c", { ctrl: true });
  await settle();
  expect(effects.calls).toEqual(["cancelRun", 'quit:{"confirm":true}']);
  t.renderer.destroy();
});

test("createInteraction: run.cancel — at true idle it arms the quit gate", async () => {
  // It used to be `enabled` only with a run or a draft, so at idle it was both
  // advertised in the footer and a complete no-op — invariant 8. The quit gate
  // is exactly the double-tap ^C path `createQuitConfirm` was written for, and
  // it notifies "press again to quit", so pressing it is never silent.
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects();
  createInteraction(t.renderer, fakePlatform(), effects);
  press(t.renderer, "c", { ctrl: true });
  await settle();
  expect(effects.calls).toEqual(["cancelRun", 'quit:{"confirm":true}']);
  t.renderer.destroy();
});

test("createInteraction: repeated Ctrl+C at the root remains available to the quit gate", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects();
  createInteraction(t.renderer, fakePlatform(), effects);
  press(t.renderer, "c", { ctrl: true });
  press(t.renderer, "c", { ctrl: true });
  await settle();
  expect(effects.calls).toEqual([
    "cancelRun",
    'quit:{"confirm":true}',
    "cancelRun",
    'quit:{"confirm":true}',
  ]);
  t.renderer.destroy();
});

test("createInteraction: run.cancel remains available while an overlay is open", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects({
    isRunActive: () => true,
    cancelRun: () => (effects.calls.push("cancelRun"), true),
  });
  const interaction = createInteraction(t.renderer, fakePlatform(), effects);
  interaction.pushOverlayContext("plan");
  press(t.renderer, "c", { ctrl: true });
  await settle();
  expect(effects.calls).toEqual(["cancelRun"]);
  t.renderer.destroy();
});

test("createInteraction: app.escape dismisses the top overlay first, short-circuiting the rest", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects({
    dismissTopOverlay: () => (effects.calls.push("dismissTopOverlay"), true),
  });
  createInteraction(t.renderer, fakePlatform(), effects);
  press(t.renderer, "escape");
  await settle();
  expect(effects.calls).toEqual(["dismissTopOverlay"]);
  t.renderer.destroy();
});

test("createInteraction: an exact action beats a longer prefix synchronously", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const interaction = createInteraction(t.renderer, fakePlatform(), fakeEffects());
  const calls: string[] = [];
  const off = interaction.keymap.registerLayer({
    priority: 951,
    commands: [
      uiCommand({
        id: "test.back",
        title: "Back",
        description: "Go back immediately",
        category: "test",
        surfaces: [],
        run: () => {
          calls.push("back");
        },
      }),
      uiCommand({
        id: "test.escape.sequence",
        title: "Long Escape sequence",
        description: "Expose an exact-versus-prefix ambiguity",
        category: "test",
        surfaces: [],
        run: () => {
          calls.push("sequence");
        },
      }),
    ],
    bindings: [
      { key: "escape", cmd: "test.back" },
      { key: "escape x", cmd: "test.escape.sequence" },
    ],
  });

  press(t.renderer, "escape");

  expect(calls).toEqual(["back"]);
  expect(interaction.keymap.hasPendingSequence()).toBe(false);
  off();
  interaction.dispose();
  t.renderer.destroy();
});

test("createInteraction: one Escape both clears an invisible pending sequence and navigates back", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects({
    dismissTopOverlay: () => (effects.calls.push("dismissTopOverlay"), true),
  });
  const interaction = createInteraction(t.renderer, fakePlatform(), effects);
  const off = interaction.keymap.registerLayer({
    commands: [
      uiCommand({
        id: "test.sequence",
        title: "Test sequence",
        description: "Test a pending multi-key sequence",
        category: "test",
        surfaces: [],
        run: () => {},
      }),
    ],
    bindings: [{ key: "g g", cmd: "test.sequence" }],
  });

  press(t.renderer, "g");
  expect(interaction.keymap.hasPendingSequence()).toBe(true);
  press(t.renderer, "escape");
  await settle();

  expect(interaction.keymap.hasPendingSequence()).toBe(false);
  expect(effects.calls).toEqual(["dismissTopOverlay"]);
  off();
  interaction.dispose();
  t.renderer.destroy();
});

test("createInteraction: Ctrl+S and Alt+S dispatch the isolation picker", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects();
  const interaction = createInteraction(t.renderer, fakePlatform(), effects);
  const off = interaction.keymap.registerLayer({
    commands: [
      uiCommand({
        id: "isolation.picker",
        title: "Isolation",
        description: "Open the isolation picker",
        category: "navigation",
        surfaces: [],
        run: () => effects.openIsolationPicker(),
      }),
    ],
  });

  press(t.renderer, "s", { ctrl: true });
  press(t.renderer, "s", { meta: true });
  await settle();

  expect(effects.calls).toEqual(["openIsolationPicker", "openIsolationPicker"]);
  off();
  interaction.dispose();
  t.renderer.destroy();
});

test("createInteraction: app.escape dispatches synchronously with no timer or microtask wait", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects({
    dismissTopOverlay: () => (effects.calls.push("dismissTopOverlay"), true),
  });
  createInteraction(t.renderer, fakePlatform(), effects);

  press(t.renderer, "escape");

  expect(effects.calls).toEqual(["dismissTopOverlay"]);
  t.renderer.destroy();
});

test("createInteraction: app.escape falls through to clearing block focus next", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects({
    dismissTopOverlay: () => (effects.calls.push("dismissTopOverlay"), false),
    clearBlockFocus: () => (effects.calls.push("clearBlockFocus"), true),
  });
  createInteraction(t.renderer, fakePlatform(), effects);
  press(t.renderer, "escape");
  await settle();
  expect(effects.calls).toEqual(["dismissTopOverlay", "clearBlockFocus"]);
  t.renderer.destroy();
});

test("createInteraction: app.escape never cancels an active run", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects({
    isRunActive: () => true,
    dismissTopOverlay: () => (effects.calls.push("dismissTopOverlay"), false),
    clearBlockFocus: () => (effects.calls.push("clearBlockFocus"), false),
    cancelRun: () => (effects.calls.push("cancelRun"), true),
  });
  createInteraction(t.renderer, fakePlatform(), effects);
  press(t.renderer, "escape");
  await settle();
  expect(effects.calls).toEqual(["dismissTopOverlay", "clearBlockFocus"]);
  t.renderer.destroy();
});

test("createInteraction: app.escape is a no-op at the root when nothing needs clearing", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects();
  createInteraction(t.renderer, fakePlatform(), effects);
  press(t.renderer, "escape");
  await settle();
  expect(effects.calls).toEqual(["dismissTopOverlay", "clearBlockFocus"]);
  t.renderer.destroy();
});

test("createInteraction: an unnamed release after Escape closes a view never reaches the strict event resolver", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const interaction = createInteraction(t.renderer, fakePlatform(), fakeEffects());
  const keymapErrors: string[] = [];
  const offError = interaction.keymap.on("error", (event) => keymapErrors.push(event.code));
  let backs = 0;
  let offView = (): void => {};
  offView = interaction.keymap.registerLayer({
    priority: 951,
    commands: [
      uiCommand({
        id: "test.workflow.back",
        title: "Back",
        description: "Close the workflow agent result",
        category: "navigation",
        surfaces: [],
        run: () => {
          backs += 1;
          offView();
        },
      }),
    ],
    bindings: [{ key: "escape", cmd: "test.workflow.back" }],
  });

  press(t.renderer, "escape", { raw: "\u001b", sequence: "\u001b", eventType: "press" });
  t.renderer.keyInput.emit(
    "keyrelease",
    new KeyEvent({
      name: "",
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      number: false,
      raw: "",
      sequence: "",
      eventType: "release",
      source: "raw",
    }),
  );
  await settle();

  expect(backs).toBe(1);
  expect(keymapErrors).not.toContain("event-match-resolver-error");
  offError();
  interaction.dispose();
  t.renderer.destroy();
});

test("createInteraction: an elicitation modal suppresses global destination bindings", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects();
  const interaction = createInteraction(t.renderer, fakePlatform(), effects);
  interaction.setModalContext("elicitation");

  press(t.renderer, "tab", { shift: true });
  await settle();
  expect(effects.calls).toEqual([]);
  t.renderer.destroy();
});

test("createInteraction: a workspace replacement blocks commands but keeps window Escape live", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects({
    interactionBlocked: () => true,
  });
  const platform = fakePlatform();
  const interaction = createInteraction(t.renderer, platform, effects);
  interaction.setModalContext("elicitation");
  interaction.configureKeyboard({
    version: 1,
    environments: {
      [interaction.keyboardEnvironmentId()]: {
        profile: "manual",
        bindings: { "run.cancel": ["ctrl+escape"] },
      },
    },
  });
  const off = interaction.keymap.registerLayer({
    priority: 951,
    commands: [
      uiCommand({
        id: "test.blocked.back",
        title: "Back",
        description: "Leave the active window during a workspace replacement",
        category: "test",
        surfaces: [],
        run: () => {
          effects.calls.push("back");
        },
      }),
    ],
    bindings: [{ key: "escape", cmd: "test.blocked.back" }],
  });

  press(t.renderer, "c", { ctrl: true });
  press(t.renderer, "escape", { ctrl: true });
  press(t.renderer, "escape");
  press(t.renderer, "z", { ctrl: true });
  await settle();

  expect(effects.calls).toEqual(["back"]);
  expect(platform.suspendCalls).toBe(0);
  off();
  interaction.dispose();
  t.renderer.destroy();
});

test("createInteraction: ctrl+z suspends the platform and signals SIGTSTP, without killing the test process", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects();
  const platform = fakePlatform();
  const killSpy = spyOn(process, "kill").mockImplementation(() => true);
  createInteraction(t.renderer, platform, effects);
  press(t.renderer, "z", { ctrl: true });
  await settle();
  expect(platform.suspendCalls).toBe(1);
  expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTSTP");
  killSpy.mockRestore();
  t.renderer.destroy();
});

test("createInteraction: a SIGCONT listener resumes the platform (no real signal is sent)", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects();
  const platform = fakePlatform();
  createInteraction(t.renderer, platform, effects);
  process.emit("SIGCONT");
  await settle();
  expect(platform.resumeCalls).toBe(1);
  t.renderer.destroy();
});

test("createInteraction: Tab, collapse and block-navigation commands each call their one effect", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects();
  createInteraction(t.renderer, fakePlatform(), effects);

  press(t.renderer, "tab");
  await settle();
  expect(effects.calls).toEqual(["focusNext"]);

  press(t.renderer, "o", { ctrl: true });
  await settle();
  expect(effects.calls).toEqual(["focusNext", "toggleExpandAll"]);

  press(t.renderer, "up", { ctrl: true });
  await settle();
  expect(effects.calls.at(-1)).toBe("focusBlock:-1");

  press(t.renderer, "down", { ctrl: true });
  await settle();
  expect(effects.calls.at(-1)).toBe("focusBlock:1");

  t.renderer.destroy();
});

test("createInteraction: the four transcript.scroll* bindings pass the documented row deltas", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects();
  createInteraction(t.renderer, fakePlatform(), effects);

  press(t.renderer, "pageup");
  await settle();
  expect(effects.calls.at(-1)).toBe("scrollTranscript:-12");

  press(t.renderer, "pagedown");
  await settle();
  expect(effects.calls.at(-1)).toBe("scrollTranscript:12");

  press(t.renderer, "up", { meta: true });
  await settle();
  expect(effects.calls.at(-1)).toBe("scrollTranscript:-3");

  press(t.renderer, "down", { meta: true });
  await settle();
  expect(effects.calls.at(-1)).toBe("scrollTranscript:3");

  press(t.renderer, "end");
  await settle();
  expect(effects.calls.at(-1)).toBe("scrollTranscript:Infinity");

  t.renderer.destroy();
});

test("createInteraction: overlay-gated commands go dark while any overlay is on the stack, and reawaken once it's empty", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects();
  const interaction = createInteraction(t.renderer, fakePlatform(), effects);

  interaction.pushOverlayContext("diff");
  press(t.renderer, "pageup");
  await settle();
  expect(effects.calls).toEqual([]);

  interaction.pushOverlayContext("plan");
  press(t.renderer, "pageup");
  await settle();
  expect(effects.calls).toEqual([]);

  interaction.popOverlayContext();
  press(t.renderer, "pageup");
  await settle();
  expect(effects.calls).toEqual([]);

  interaction.popOverlayContext();
  press(t.renderer, "pageup");
  await settle();
  expect(effects.calls).toEqual(["scrollTranscript:-12"]);

  t.renderer.destroy();
});

test("createInteraction: an active window isolates ordinary shortcuts but not Ctrl+C", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects({
    isRunActive: () => true,
    cancelRun: () => (effects.calls.push("cancelRun"), true),
  });
  const interaction = createInteraction(t.renderer, fakePlatform(), effects);

  interaction.pushOverlayContext("agentPicker");
  press(t.renderer, "c", { ctrl: true });
  press(t.renderer, "s", { meta: true });
  press(t.renderer, "p", { ctrl: true });
  press(t.renderer, "tab");
  press(t.renderer, "tab", { shift: true });
  await settle();
  expect(effects.calls).toEqual(["cancelRun"]);

  t.renderer.destroy();
});

test("createInteraction: a repeated Ctrl+C with a window open cancels only once", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects({
    isRunActive: () => true,
    cancelRun: () => (effects.calls.push("cancelRun"), true),
  });
  const interaction = createInteraction(t.renderer, fakePlatform(), effects);
  interaction.pushOverlayContext("plan");

  press(t.renderer, "c", { ctrl: true });
  press(t.renderer, "c", { ctrl: true, repeated: true });
  await settle();

  expect(effects.calls).toEqual(["cancelRun"]);
  interaction.dispose();
  t.renderer.destroy();
});

test("createInteraction: two deliberate Ctrl+C presses confirm quit in a window", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects();
  const interaction = createInteraction(t.renderer, fakePlatform(), effects);
  interaction.pushOverlayContext("plan");

  press(t.renderer, "c", { ctrl: true });
  press(t.renderer, "c", { ctrl: true });
  await settle();

  expect(effects.calls).toEqual([
    "cancelRun",
    'quit:{"confirm":true}',
    "cancelRun",
    'quit:{"confirm":true}',
  ]);
  interaction.dispose();
  t.renderer.destroy();
});

test("createInteraction: repeat protection follows a rebound run.cancel key", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects({
    isRunActive: () => true,
    cancelRun: () => (effects.calls.push("cancelRun"), true),
  });
  const interaction = createInteraction(t.renderer, fakePlatform(), effects);
  const id = interaction.keyboardEnvironmentId();
  interaction.configureKeyboard({
    version: 1,
    environments: {
      [id]: { profile: "manual", bindings: { "run.cancel": ["ctrl+x"] } },
    },
  });
  interaction.pushOverlayContext("plan");

  press(t.renderer, "x", { ctrl: true });
  press(t.renderer, "x", { ctrl: true, repeated: true });
  await settle();

  expect(effects.calls).toEqual(["cancelRun"]);
  interaction.dispose();
  t.renderer.destroy();
});

test("createInteraction: returns keymap/renderer handles alongside the overlay-context functions", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects();
  const interaction = createInteraction(t.renderer, fakePlatform(), effects);
  expect(interaction.renderer).toBe(t.renderer);
  expect(typeof interaction.keymap.registerLayer).toBe("function");
  expect(typeof interaction.pushOverlayContext).toBe("function");
  expect(typeof interaction.popOverlayContext).toBe("function");
  t.renderer.destroy();
});

test("createInteraction: queued input is inert after the renderer destroys its keymap host", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects();
  const listenersBefore = new Set(t.renderer.keyInput.listeners("keypress"));
  createInteraction(t.renderer, fakePlatform(), effects);
  const queuedListener = t.renderer.keyInput
    .listeners("keypress")
    .find((listener) => !listenersBefore.has(listener));
  expect(queuedListener).toBeDefined();

  t.renderer.destroy();

  expect(() =>
    queuedListener!(
      new KeyEvent({
        name: "escape",
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
      } as ConstructorParameters<typeof KeyEvent>[0]),
    ),
  ).not.toThrow();
  expect(effects.calls).toEqual([]);
});

test("createInteraction: app.escape clears a non-empty draft without cancelling the run", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const effects = fakeEffects({
    isDraftNonEmpty: () => true,
    dismissTopOverlay: () => (effects.calls.push("dismissTopOverlay"), false),
    clearBlockFocus: () => (effects.calls.push("clearBlockFocus"), false),
  });
  createInteraction(t.renderer, fakePlatform(), effects);
  press(t.renderer, "escape");
  await settle();
  expect(effects.calls).toEqual([
    "dismissTopOverlay",
    "clearBlockFocus",
    "clearInputDraft",
    "hint:Draft cleared",
  ]);
  t.renderer.destroy();
});
