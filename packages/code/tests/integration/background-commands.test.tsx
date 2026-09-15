import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createCommands, type CommandUi } from "../../src/keys/commands.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { registerBackgroundCommands } from "../../src/features/background/commands.ts";
import type { BackgroundController } from "../../src/features/background/controller.ts";
import { BackgroundView } from "../../src/features/background/view.tsx";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { openRender } from "../helpers/tracked-render.ts";
import { hostedRef } from "../helpers/hosted-run.ts";

function fixture() {
  const keys = createFakeKeymap();
  const calls: string[] = [];
  const backgrounds: BackgroundController = {
    offerOnStartup: true,
    resolveRecovery: async () => {},
    list: async () => [hostedRef()],
    background: async () => {
      calls.push("handoff");
    },
    attach: async (id, control) => {
      calls.push(`attach:${id}:${control ?? "default"}`);
    },
    cancel: async (id) => {
      calls.push(`cancel:${id}`);
    },
    newConversation: () => {
      calls.push("new");
    },
  };
  const notes: string[] = [];
  const ui: CommandUi = {
    openView: (name) => {
      calls.push(`view:${name}`);
    },
    dismiss: () => {},
    commandFailed: (_name, error) => {
      notes.push(String(error));
    },
  };
  return {
    keys,
    calls,
    backgrounds,
    notes,
    ui,
    notify: (message: string) => {
      notes.push(message);
    },
  };
}

test("slash commands perform explicit actions and preserve invalid syntax without model dispatch", async () => {
  const f = fixture();
  const done = createRoot((dispose) => {
    const commands = createCommands(
      { keymap: f.keys.keymap } as Interaction,
      { clearSession: () => {}, status: () => {}, exportSession: () => {} },
      f.ui,
    );
    registerBackgroundCommands(commands.scope(), f);
    expect(commands.route("background.open", "list")).toBe(true);
    expect(commands.route("background.open", "cancel exec_background")).toBe(true);
    expect(commands.route("background.attach", "exec_background")).toBe(true);
    expect(commands.route("background.open", "")).toBe(true);
    expect(commands.route("background.open", "cancel")).toBe("block");
    expect(commands.route("background.attach", "exec_background extra")).toBe("block");
    return () => {
      commands.dispose();
      dispose();
    };
  });
  await Promise.resolve();
  expect(f.calls).toEqual([
    "view:background.open",
    "cancel:exec_background",
    "attach:exec_background:default",
    "handoff",
  ]);
  expect(f.notes.some((note) => note.startsWith("Usage:"))).toBe(true);
  done();
});

test("startup discovery rechecks user interaction after its asynchronous list", async () => {
  const f = fixture();
  const pending = Promise.withResolvers<ReturnType<typeof hostedRef>[]>();
  f.backgrounds.list = () => pending.promise;
  let canOpen = true;
  let offer!: ReturnType<typeof registerBackgroundCommands>;
  const dispose = createRoot((done) => {
    const commands = createCommands(
      { keymap: f.keys.keymap } as Interaction,
      { clearSession: () => {}, status: () => {}, exportSession: () => {} },
      f.ui,
    );
    offer = registerBackgroundCommands(commands.scope(), f);
    return () => {
      commands.dispose();
      done();
    };
  });
  const opened = offer.offer(() => canOpen);
  canOpen = false;
  pending.resolve([hostedRef()]);
  await opened;
  expect(f.calls).toEqual([]);
  expect(f.notes.join(" ")).toContain("/background list");
  dispose();
});

test("background view displays execution identity and keyboard choices without automatic attach", async () => {
  const f = fixture();
  f.backgrounds.list = async () => [
    hostedRef({
      execution_id: "ordinary-print",
      title: "Ordinary print result",
      disconnect_policy: "cancel",
      execution_state: "closed",
    }),
    hostedRef(),
  ];
  const { host } = createViewHost({
    interaction: { keymap: f.keys.keymap } as Interaction,
    close: () => {
      f.calls.push("close");
    },
    dispatch: () => {},
  });
  const rendered = await openRender(() => BackgroundView(host, { ...f, startup: true }), {
    width: 100,
    height: 30,
  });
  await Promise.resolve();
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("Background runs");
  expect(frame).toContain("exec_background");
  expect(frame).not.toContain("Ordinary print result");
  expect(frame).toContain("Start another conversation");
  expect(f.calls).toEqual([]);
  f.keys.press("return");
  await Promise.resolve();
  expect(f.calls).toEqual(["attach:exec_background:default", "close"]);
});

test("starting another conversation does not attach or cancel the background run", async () => {
  const f = fixture();
  const { host } = createViewHost({
    interaction: { keymap: f.keys.keymap } as Interaction,
    close: () => {
      f.calls.push("close");
    },
    dispatch: () => {},
  });
  const rendered = await openRender(() => BackgroundView(host, f), { width: 80, height: 24 });
  await Promise.resolve();
  await rendered.renderOnce();
  f.keys.press("down");
  f.keys.press("return");
  expect(f.calls).toEqual(["new", "close"]);
});
