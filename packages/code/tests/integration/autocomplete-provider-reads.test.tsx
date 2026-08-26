import { expect, test } from "bun:test";
import type { JSX } from "solid-js";
import { useRenderer } from "@opentui/solid";
import { openRender } from "../helpers/tracked-render.ts";
import type { TextareaRenderable } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { InputDock } from "../../src/views/InputDock.tsx";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { Platform } from "../../src/adapters/platform.ts";
import { registerWhenField } from "../../src/keys/when-dsl.ts";
import { createPromptHistory } from "../../src/core/prompt-history.ts";
import type { CompleteProvider } from "../../src/views/input/autocomplete.ts";

const provider: CompleteProvider = {
  id: "command",
  trigger: "/",
  label: "commands",
  query: () => [{ label: "help", value: "help" }],
};

/**
 * Hosts the dock with a `providers` prop whose every read is counted.
 *
 * @remarks Solid compiles a prop whose expression contains a call into a getter,
 *   so this counter measures exactly what the real `App.tsx` call site pays: how
 *   many times the provider list is rebuilt as the user types.
 */
function Host(props: {
  count: () => void;
  onReady: (el: TextareaRenderable) => void;
}): JSX.Element {
  const renderer = useRenderer();
  const keymap = createDefaultOpenTuiKeymap(renderer);
  registerWhenField(keymap);
  const interaction = {
    keymap,
    renderer,
    pushOverlayContext: () => {},
    popOverlayContext: () => {},
  } as unknown as Interaction;
  const build = (): CompleteProvider[] => {
    props.count();
    return [provider];
  };
  return (
    <InputDock
      interaction={interaction}
      renderer={renderer}
      platform={{ readClipboardImage: () => Promise.resolve(null) } as unknown as Platform}
      history={createPromptHistory(200, null)}
      providers={build()}
      onSubmit={() => {}}
      onSlashCommand={() => "handled"}
      onBashCommand={() => true}
      onReady={props.onReady}
    />
  );
}

test("the dock reads its provider list once per keystroke, not twice", async () => {
  let reads = 0;
  let el: TextareaRenderable | undefined;
  const t = await openRender(
    (() => (
      <Host
        count={() => {
          reads += 1;
        }}
        onReady={(e) => (el = e)}
      />
    )) as never,
    { width: 100, height: 16 },
  );
  await t.renderOnce();

  const keystrokes = 10;
  reads = 0;
  for (let i = 0; i < keystrokes; i += 1) {
    el!.setText("/hel" + "p".repeat(i));
    await t.renderOnce();
  }
  t.renderer.destroy();

  expect(reads).toBeGreaterThan(0);
  /**
   * One read per refresh is the contract. The bound is `keystrokes` rather than
   * an exact count because a render may refresh the popup more than once for
   * reasons of its own; what must not come back is the second read *within* a
   * refresh, which put this at 2x.
   */
  expect(reads).toBeLessThanOrEqual(keystrokes);
});
