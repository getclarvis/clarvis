import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import type { Interaction } from "../../src/keys/interaction.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { SetupView, type SetupState } from "../../src/views/onboarding/SetupView.tsx";
import { RecoveryView, type StartupIssue } from "../../src/views/onboarding/RecoveryView.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { openRender } from "../helpers/tracked-render.ts";

function hostHarness() {
  const { keymap, press } = createFakeKeymap();
  const calls: string[] = [];
  const { host, controls } = createViewHost({
    interaction: {
      keymap,
      pushOverlayContext: () => {},
      popOverlayContext: () => {},
    } as unknown as Interaction,
    close: () => calls.push("close"),
    dispatch: (name) => calls.push(`dispatch:${name}`),
  });
  return { host, controls, press, calls };
}

test("guided setup renders every phase and exposes only the phase's valid primary action", async () => {
  const [state, setState] = createSignal<SetupState>({
    phase: "welcome",
    detail: "Choose a provider.",
  });
  const mounted = hostHarness();
  const deps = {
    state,
    begin: () => mounted.calls.push("begin"),
    retry: () => mounted.calls.push("retry"),
    finish: () => mounted.calls.push("finish"),
  };
  const rendered = await openRender((() => SetupView(mounted.host, deps)) as never, {
    width: 100,
    height: 28,
  });

  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain(".d8888b.");
  expect(rendered.captureCharFrame()).toContain("Connect a provider and choose a model.");
  expect(rendered.captureCharFrame()).toContain("saves the provider and model before Ready");
  expect(rendered.captureCharFrame()).toContain("[↵] begin setup");
  mounted.press("return");
  expect(mounted.calls).toContain("begin");

  setState({ phase: "preparing", detail: "Installing the agent fleet" });
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Preparing Clarvis");
  expect(rendered.captureCharFrame()).toContain("Installing the agent fleet");
  expect(rendered.captureCharFrame()).not.toContain("[↵]");

  setState({ phase: "error", detail: "credential was rejected" });
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Setup needs another try");
  expect(rendered.captureCharFrame()).toContain("credential was rejected");
  mounted.press("return");
  expect(mounted.calls).toContain("retry");

  setState({ phase: "ready", detail: "done", agent: "coder", model: "anthropic/sonnet" });
  await rendered.renderOnce();
  const ready = rendered.captureCharFrame();
  expect(ready).toContain("Clarvis is ready");
  expect(ready).toContain("Agent   coder");
  expect(ready).toContain("Model   anthropic/sonnet");
  mounted.press("return");
  mounted.press("escape");
  expect(mounted.calls).toEqual(["begin", "retry", "finish"]);

  rendered.renderer.destroy();
  mounted.controls.dispose();
});

test("guided setup omits the splash when the whole first-run journey cannot fit it", async () => {
  const [state] = createSignal<SetupState>({
    phase: "welcome",
    detail: "Choose a provider.",
  });
  const mounted = hostHarness();
  const rendered = await openRender(
    (() =>
      SetupView(mounted.host, {
        state,
        begin: () => {},
        retry: () => {},
        finish: () => {},
      })) as never,
    { width: 75, height: 23 },
  );

  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).not.toContain(".d8888b.");
  expect(frame).toContain("Connect a provider and choose a model.");

  rendered.renderer.destroy();
  mounted.controls.dispose();
});

test("recovery presents the focused blocker and wires repair, Doctor and ready", async () => {
  const [issue, setIssue] = createSignal<StartupIssue | undefined>({
    label: "provider",
    detail: "no usable model",
    hint: "Choose a provider and model.",
  });
  const [ready, setReady] = createSignal(false);
  const mounted = hostHarness();
  const deps = {
    issue,
    ready,
    resolve: () => mounted.calls.push("resolve"),
    openDoctor: () => mounted.calls.push("doctor"),
    onReady: () => mounted.calls.push("ready"),
  };
  const rendered = await openRender((() => RecoveryView(mounted.host, deps)) as never, {
    width: 100,
    height: 28,
  });

  await rendered.renderOnce();
  const blocked = rendered.captureCharFrame();
  expect(blocked).toContain("Repair Clarvis");
  expect(blocked).toContain("provider: no usable model");
  expect(blocked).toContain("Choose a provider and model.");
  expect(blocked).toContain("[↵] repair");
  expect(blocked).toContain("[d] open Doctor");
  mounted.press("return");
  mounted.press("d");
  mounted.press("q");
  mounted.press("escape");
  expect(mounted.calls).toEqual(["resolve", "doctor"]);

  setIssue(undefined);
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("configuration: rechecking");
  expect(rendered.captureCharFrame()).toContain("Open the focused repair and return here.");

  setReady(true);
  await rendered.renderOnce();
  await Promise.resolve();
  expect(mounted.calls).toContain("ready");

  rendered.renderer.destroy();
  mounted.controls.dispose();
});
