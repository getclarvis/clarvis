import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import type { PluginHookReview } from "@clarvis/protocol";
import type { Interaction } from "../../src/keys/interaction.ts";
import { HookBrowser, type OperatorHook } from "../../src/views/config/HookBrowser.tsx";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

function mount(review: PluginHookReview, operatorHooks: OperatorHook[] = []) {
  const { keymap, press } = createFakeKeymap();
  const approved: string[] = [];
  const revoked: string[] = [];
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  return {
    host,
    approved,
    revoked,
    press,
    deps: {
      hooks: () => [review],
      operatorHooks: () => operatorHooks,
      approve: (value: PluginHookReview) => approved.push(value.fingerprint),
      revoke: (value: PluginHookReview) => revoked.push(value.fingerprint),
    },
  };
}

test("shows and approves the exact normalized hook definition", async () => {
  const mounted = mount({
    plugin: "demo",
    fingerprint: `sha256:${"a".repeat(64)}`,
    definition: { event: "run_start", command: "python3 check.py" },
    approved: false,
  });
  const rendered = await openRender((() => HookBrowser(mounted.host, mounted.deps)) as never, {
    width: 120,
    height: 20,
  });
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("review required");
  expect(frame).toContain("python3 check.py");
  expect(frame).toContain("sha256:aaaaaaaa");
  mounted.press("t");
  expect(mounted.approved).toEqual([`sha256:${"a".repeat(64)}`]);
  rendered.renderer.destroy();
});

test("revokes an already approved definition", async () => {
  const mounted = mount({
    plugin: "demo",
    fingerprint: `sha256:${"b".repeat(64)}`,
    definition: { event: "run_start", command: "check" },
    approved: true,
  });
  const rendered = await openRender((() => HookBrowser(mounted.host, mounted.deps)) as never, {
    width: 100,
    height: 16,
  });
  await rendered.renderOnce();
  mounted.press("x");
  expect(mounted.revoked).toEqual([`sha256:${"b".repeat(64)}`]);
  rendered.renderer.destroy();
});

test("lists the operator's own settings.json hooks beside the plugins'", async () => {
  // The Extensions hub advertises this screen as "Configure workspace
  // automations", and it used to show plugin-contributed hooks only — so an
  // operator's own hooks appeared nowhere in the application.
  const mounted = mount(
    {
      plugin: "demo",
      fingerprint: `sha256:${"c".repeat(64)}`,
      definition: { event: "run_start", command: "plugin-side" },
      approved: true,
    },
    [{ scope: "workspace", definition: { event: "pre_tool_use", command: "operator-side" } }],
  );
  const rendered = await openRender((() => HookBrowser(mounted.host, mounted.deps)) as never, {
    width: 120,
    height: 24,
  });
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("plugin-side");
  expect(frame).toContain("operator-side");
  expect(frame).toContain("workspace");
  rendered.renderer.destroy();
});
