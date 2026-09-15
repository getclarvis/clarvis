import { expect, test } from "bun:test";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { ViewFactory } from "../../src/keys/commands.ts";
import { createOverlayHost, type OverlayHost } from "../../src/views/overlay-host.ts";

const view: ViewFactory = () => null;

function harness(): {
  host: OverlayHost;
  log: string[];
  toasts: string[];
  commands: string[];
  focuses: () => number;
  run: (name: string) => unknown;
  escape: () => void;
} {
  const log: string[] = [];
  const toasts: string[] = [];
  const commands: string[] = [];
  const data = new Map<string, unknown>();
  let focused = 0;
  const layers: {
    active: boolean;
    when?: string;
    enabled?: unknown;
    commands?: { name: string; run: (...args: never[]) => unknown }[];
  }[] = [];
  const enabled = (value: unknown): boolean => {
    if (value === undefined || value === true) return true;
    if (typeof value === "function") return Boolean(value());
    if (
      typeof value === "object" &&
      value !== null &&
      "get" in value &&
      typeof value.get === "function"
    )
      return Boolean(value.get());
    return false;
  };
  const interaction = {
    keymap: {
      setData: (name: string, value: unknown) => data.set(name, value),
      getData: (name: string) => data.get(name),
      registerLayer(opts: {
        priority?: number;
        when?: string;
        enabled?: unknown;
        commands?: { name: string; run: (...args: never[]) => unknown }[];
      }) {
        log.push(`on:${opts.priority}`);
        const layer = {
          active: true,
          commands: opts.commands,
          when: opts.when,
          enabled: opts.enabled,
        };
        layers.push(layer);
        return () => {
          layer.active = false;
          log.push(`off:${opts.priority}`);
        };
      },
    },
    pushOverlayContext: (kind: string) => log.push(`push:${kind}`),
    popOverlayContext: () => log.push("pop"),
  } as unknown as Interaction;
  const host = createOverlayHost({
    interaction: () => interaction,
    runCommand: (name) => commands.push(name),
    focusInput: () => focused++,
    notify: (m, tone) => toasts.push(tone ? `${tone}:${m}` : m),
  });
  return {
    host,
    log,
    toasts,
    commands,
    focuses: () => focused,
    run: (name) => {
      for (const layer of [...layers].reverse()) {
        if (!layer.active || !enabled(layer.enabled)) continue;
        const match = layer.when ? /^([A-Za-z]\w*)==(.+)$/.exec(layer.when) : null;
        if (match && data.get(match[1]!) !== match[2]) continue;
        const command = layer.commands?.find((candidate) => candidate.name === name);
        if (command) return command.run();
      }
      throw new Error(`active command not found: ${name}`);
    },
    escape: () => {
      for (const layer of [...layers].reverse()) {
        if (!layer.active || !enabled(layer.enabled)) continue;
        const match = layer.when ? /^([A-Za-z]\w*)==(.+)$/.exec(layer.when) : null;
        if (match && data.get(match[1]!) !== match[2]) continue;
        const command = layer.commands?.find((candidate) => candidate.name === "view.escape");
        if (!command) continue;
        command.run();
        return;
      }
    },
  };
}

test("openPicker: opens over a bare transcript only; dismiss pops the context and refocuses input", () => {
  const h = harness();
  expect(h.host.openPicker("agentPicker")).toBe(true);
  expect(h.host.overlay()).toBe("agentPicker");
  expect(h.log).toEqual(["push:agentPicker"]);
  expect(h.host.openPicker("sessionPicker")).toBe(false);
  expect(h.host.overlay()).toBe("agentPicker");
  expect(h.host.dismissTop()).toBe(true);
  expect(h.host.overlay()).toBe("none");
  expect(h.log).toEqual(["push:agentPicker", "pop"]);
  expect(h.focuses()).toBe(1);
  expect(h.host.dismissTop()).toBe(false);
});

test("a blocked openPicker surfaces a warn notify instead of failing silently", () => {
  const h = harness();
  expect(h.host.openPicker("agentPicker")).toBe(true);
  expect(h.toasts).toEqual([]);
  expect(h.host.openPicker("sessionPicker")).toBe(false);
  expect(h.toasts).toEqual(["warn:close the current overlay first"]);
});

test("a picker blocks view navigation and leaves the current overlay intact", () => {
  const h = harness();
  expect(h.host.openPicker("agentPicker")).toBe(true);
  h.host.ui.openView("providers.open", view);
  expect(h.host.overlay()).toBe("agentPicker");
  expect(h.toasts).toEqual(["", "warn:close the current overlay first"]);
});

test("openView: mounts the view with its ^s/^t (810) and esc (950) layers", () => {
  const h = harness();
  h.host.ui.openView("providers.open", view);
  expect(h.host.overlay()).toBe("view");
  expect(h.host.view()?.name).toBe("providers.open");
  expect(h.log).toEqual(["on:810", "on:950", "push:view"]);
});

test("view→view chaining keeps the parent mounted, deactivates it, and pushes one view context", () => {
  const h = harness();
  h.host.ui.openView("providers.open", view);
  h.host.ui.openView("agents.open", view);
  expect(h.log).toEqual(["on:810", "on:950", "push:view", "on:810", "on:950"]);
  expect(h.host.views().map((frame) => frame.name)).toEqual(["providers.open", "agents.open"]);
  expect(h.host.views()[0]!.host.active()).toBe(false);
  expect(h.host.views()[1]!.host.active()).toBe(true);
  expect(h.host.view()?.name).toBe("agents.open");
  h.escape();
  expect(h.host.view()?.name).toBe("providers.open");
  expect(h.host.views()[0]!.host.active()).toBe(true);
  expect(h.host.overlay()).toBe("view");
  h.escape();
  expect(h.host.overlay()).toBe("none");
  expect(h.log.filter((e) => e === "pop")).toHaveLength(1);
});

test("a child calling host.close returns to its mounted parent", () => {
  const h = harness();
  h.host.ui.openView("settings.open", view);
  h.host.ui.openView("keyboard.open", view);
  expect(h.host.views().map((frame) => frame.name)).toEqual(["settings.open", "keyboard.open"]);

  h.host.view()!.host.close();

  expect(h.host.overlay()).toBe("view");
  expect(h.host.view()?.name).toBe("settings.open");
});

test("a deep-linked child seeds a real parent route and Escape returns without rerunning commands", () => {
  const h = harness();
  h.host.ui.openView("providers.open", view, {
    parent: { name: "doctor.open", factory: view, scope: "workspace" },
    scope: "workspace",
  });
  expect(h.host.views().map((frame) => frame.name)).toEqual(["doctor.open", "providers.open"]);
  expect(h.host.views()[0]!.host.scope()).toBe("workspace");
  h.escape();
  expect(h.commands).toEqual([]);
  expect(h.host.view()?.name).toBe("doctor.open");
});

test("viewDirty tracks the mounted view's host and clears on dismiss", () => {
  const h = harness();
  expect(h.host.viewDirty()).toBe(false);
  h.host.ui.openView("providers.open", view);
  h.host.view()!.host.markDirty(true);
  expect(h.host.viewDirty()).toBe(true);
  h.host.dismissTop();
  expect(h.host.viewDirty()).toBe(false);
});

test("interaction blocking suspends a mounted view without discarding its draft", async () => {
  const h = harness();
  h.host.ui.openView("providers.open", view);
  h.host.view()!.host.markDirty(true);

  h.host.setInteractionBlocked(true);
  expect(h.host.view()?.host.active()).toBe(false);
  expect(h.host.viewDirty()).toBe(true);
  expect(() => h.run("view.save")).toThrow("active command not found");

  h.host.setInteractionBlocked(false);
  expect(h.host.view()?.host.active()).toBe(true);
  expect(h.host.viewDirty()).toBe(true);
  await h.run("view.save");
});

test("a rejected view save is reported without escaping the command layer", async () => {
  const h = harness();
  h.host.ui.openView("providers.open", view);
  h.toasts.length = 0;
  h.host.view()!.host.onSave(async () => {
    throw new Error("disk full");
  });
  h.host.view()!.host.markDirty(true);

  await h.run("view.save");

  expect(h.toasts).toEqual(["error:save failed: disk full"]);
});

test("dismissTopUnlessDirty: a clean mounted view is torn down exactly like a plain dismiss", () => {
  const h = harness();
  h.host.ui.openView("providers.open", view);
  expect(h.host.dismissTopUnlessDirty({ reason: "a question is waiting" })).toBe(true);
  expect(h.host.overlay()).toBe("none");
  expect(h.log).toEqual(["on:810", "on:950", "push:view", "off:810", "off:950", "pop"]);
  expect(h.toasts).toEqual([""]);
});

test("dismissTopUnlessDirty: a dirty view is kept mounted and never reaches controls.dispose()", () => {
  const h = harness();
  h.host.ui.openView("providers.open", view);
  h.host.view()!.host.markDirty(true);
  expect(h.host.dismissTopUnlessDirty({ reason: "a question is waiting" })).toBe(false);
  expect(h.host.overlay()).toBe("view");
  expect(h.host.view()?.name).toBe("providers.open");
  expect(h.host.viewDirty()).toBe(true);
  expect(h.log).toEqual(["on:810", "on:950", "push:view"]);
  expect(h.toasts).toEqual(["", "warn:a question is waiting"]);
});

test("dismissTopUnlessDirty guards dirty parents hidden below a clean child", () => {
  const h = harness();
  h.host.ui.openView("providers.open", view);
  h.host.view()!.host.markDirty(true);
  h.host.ui.openView("agents.open", view);
  expect(h.host.view()?.host.dirty()).toBe(false);
  expect(h.host.dismissTopUnlessDirty({ reason: "a question is waiting" })).toBe(false);
  expect(h.host.views().map((frame) => frame.name)).toEqual(["providers.open", "agents.open"]);
  h.escape();
  expect(h.host.view()?.name).toBe("providers.open");
  expect(h.host.viewDirty()).toBe(true);
});

test("dismissTopUnlessDirty: a picker has nothing to lose and still closes; with none it is a no-op", () => {
  const h = harness();
  expect(h.host.dismissTopUnlessDirty({ reason: "a question is waiting" })).toBe(false);
  expect(h.host.openPicker("agentPicker")).toBe(true);
  expect(h.host.dismissTopUnlessDirty({ reason: "a question is waiting" })).toBe(true);
  expect(h.host.overlay()).toBe("none");
  expect(h.toasts).toEqual([]);
});

test("commandFailed funnels into an error toast", () => {
  const h = harness();
  h.host.ui.commandFailed("providers.open", new Error("boom"));
  expect(h.toasts).toEqual(["error:providers.open failed: boom"]);
});

test("dispose tears down every mounted view layer and overlay context without refocusing", () => {
  const h = harness();
  h.host.ui.openView("settings.open", view);
  h.host.ui.openView("providers.open", view);

  h.host.dispose();
  h.host.dispose();

  expect(h.host.overlay()).toBe("none");
  expect(h.host.views()).toEqual([]);
  expect(h.log.filter((entry) => entry.startsWith("off:"))).toHaveLength(4);
  expect(h.log.filter((entry) => entry === "pop")).toHaveLength(1);
  expect(h.focuses()).toBe(0);
  expect(h.host.openPicker("agentPicker")).toBe(false);
  h.host.ui.openView("late", view);
  expect(h.host.overlay()).toBe("none");
});

test("dispose releases an active picker exactly once", () => {
  const h = harness();
  h.host.openPicker("plan");
  h.host.dispose();
  h.host.dispose();
  expect(h.log).toEqual(["push:plan", "pop"]);
  expect(h.focuses()).toBe(0);
});

test("a picker returns the user to whatever asked for it", () => {
  // A picker cannot mount over a config view, so the Workflows hub closes itself
  // before opening the agent picker — and one Escape then landed on the root
  // screen, two semantic levels from where the user was.
  const h = harness();
  const returns: number[] = [];
  expect(h.host.openPicker("agentPicker", () => returns.push(1))).toBe(true);
  expect(returns).toEqual([]);
  h.host.dismissTop();
  expect(returns).toEqual([1]);

  // It runs once, and a later picker with no route does not re-run it.
  h.host.openPicker("agentPicker");
  h.host.dismissTop();
  expect(returns).toEqual([1]);
});

test("a refused picker never arms a return route", () => {
  const h = harness();
  const returns: number[] = [];
  h.host.openPicker("diff");
  expect(h.host.openPicker("agentPicker", () => returns.push(1))).toBe(false);
  h.host.dismissTop();
  expect(returns).toEqual([]);
});
