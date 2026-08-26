import { expect, test } from "bun:test";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { useRenderer } from "@opentui/solid";
import { openRender } from "../helpers/tracked-render.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { createOverlayHost } from "../../src/views/overlay-host.ts";
import { Show } from "solid-js";
import { ProvidersPanel } from "../../src/views/config/ProvidersPanel.tsx";
import { registerUiActionFields } from "../../src/keys/actions.ts";
import type { ProviderConfig, Scope, SettingsAdapter } from "../../src/adapters/settings.ts";
import type { KeysAdapter } from "../../src/adapters/provider-secrets.ts";
import type { CodeConfigStore } from "../../src/adapters/code-config.ts";

process.setMaxListeners(50);

const PROVIDER: ProviderConfig = {
  name: "openrouter",
  kind: "openai-compatible",
  base_url: "https://openrouter.ai/api/v1",
  api_key_env: "OPENROUTER_API_KEY",
};

function settingsFake(): SettingsAdapter {
  const providers = [PROVIDER];
  return {
    version: () => 0,
    read: (scope: Scope) => (scope === "global" ? { providers } : undefined),
    origin: () => "global",
    planRepair: () => null,
    applyRepair: async () => {},
    knownGrants: () => undefined,
    effectiveProviders: () => providers.map((p) => ({ provider: p, origin: "global" as const })),
    withheldWorkspaceFields: () => [],
    workspaceTrust: () => "inert",
    setWorkspaceTrust: async () => {},
    envStatus: () => "keyfile",
    validateProviders: () => ({ ok: true }),
    refs: () => ({ agents: [], defaultModel: false }),
    modelRefs: () => ({ agents: [], defaultModel: false }),
    effective: () => ({ providers }),
    corrupt: () => null,
    sources: () => ({ global: "/tmp/settings.json" }),
    write: async () => {},
    declaredMcpServers: () => [],
    reload: async () => {},
  } as unknown as SettingsAdapter;
}

/**
 * The real panel, over a real keymap, asserting what the footer paints.
 *
 * @remarks The other Providers render tests mount over a fake keymap, which
 * cannot answer this: the footer is projected from `getActiveKeys`, so a fake
 * keymap makes the question disappear. This one uses a real keymap and the real
 * panel, and it **passes** — the verbs reach the footer here.
 *
 * It was kept as the baseline for what was then an open finding: in the shipped
 * application, `add` and `delete` were registered but absent from the footer
 * despite ample width.
 *
 * **Located and fixed on 2026-08-22, and it was none of the things this comment
 * used to rule out.** The cause was `tierLimit`'s cap on segment *count* in
 * `src/ui/patterns/active-actions.ts`: the panel's segments fit, but the rung below 140 seated
 * fewer than the rung above and `help` reserves one seat, so `delete` was
 * dropped at 132 columns with 29 to spare. The rungs at and above 100 are now
 * one rung, leaving `fits` to decide.
 *
 * The "ruled out with evidence: the footer's segment cap (raising it to 8 and to
 * 10 changed nothing)" above was a **false negative**, and worth keeping as the
 * warning it is: raising the cap changed nothing *in this harness* because this
 * harness never had enough candidates to reach it. A negative result from a
 * fixture smaller than the thing it models is not a negative result.
 *
 * This test is still real coverage of the overlay-host mount path. It is not the
 * reproduction — that lives in `tests/unit/band-monotonic.test.ts`, which drives
 * the budget directly across every width.
 */
test("the Providers footer offers its registered mutation verbs", async () => {
  const t = await openRender(
    (() => {
      const keymap = createDefaultOpenTuiKeymap(useRenderer());
      registerUiActionFields(keymap);
      const { host } = createViewHost({
        interaction: {
          keymap,
          renderer: undefined as never,
          pushOverlayContext: () => {},
          popOverlayContext: () => {},
          setModalContext: () => {},
          keyboardEnvironment: undefined as never,
          keyboardEnvironmentId: undefined as never,
          configureKeyboard: () => {},
          dispose: () => {},
        },
        close: () => {},
        dispatch: () => {},
      });
      return ProvidersPanel(host, {
        settings: settingsFake(),
        keys: { read: () => undefined, write: async () => {} } as unknown as KeysAdapter,
        code: { read: () => ({}) } as unknown as CodeConfigStore,
        notify: () => {},
        catalog: null,
      } as never);
    }) as never,
    { width: 160, height: 45 },
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  t.renderer.destroy();
  const footer = frame.split("\n").find((row) => row.includes("[\u21b5] open")) ?? "";
  expect(footer).toContain("[a] add");
  expect(footer).toContain("[d] delete");
});

/**
 * The same panel, mounted the way the application mounts it: through
 * `overlay-host`'s `openView`, which wraps the view host and registers a
 * `LAYER.LIST` layer of its own beside the level's.
 */
test("mounted through the overlay host, the footer still offers the verbs", async () => {
  const t = await openRender(
    (() => {
      const keymap = createDefaultOpenTuiKeymap(useRenderer());
      registerUiActionFields(keymap);
      const interaction = {
        keymap,
        renderer: undefined as never,
        pushOverlayContext: () => {},
        popOverlayContext: () => {},
        setModalContext: () => {},
        keyboardEnvironment: undefined as never,
        keyboardEnvironmentId: undefined as never,
        configureKeyboard: () => {},
        dispose: () => {},
      };
      const overlays = createOverlayHost({
        interaction: () => interaction as never,
        runCommand: () => {},
        focusInput: () => {},
        notify: () => {},
      });
      overlays.ui.openView("providers.open", (host) =>
        ProvidersPanel(
          host as never,
          {
            settings: settingsFake(),
            keys: { read: () => undefined, write: async () => {} } as unknown as KeysAdapter,
            code: { read: () => ({}) } as unknown as CodeConfigStore,
            notify: () => {},
            catalog: null,
          } as never,
        ),
      );
      return (
        <Show when={overlays.view()} keyed>
          {(frame: { factory: (host: unknown) => unknown; host: unknown }) =>
            frame.factory(frame.host) as never
          }
        </Show>
      );
    }) as never,
    { width: 160, height: 45 },
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  t.renderer.destroy();
  const footer = frame.split("\n").find((row) => row.includes("[\u21b5] open")) ?? "";
  expect(footer).toContain("[a] add");
  expect(footer).toContain("[d] delete");
});
