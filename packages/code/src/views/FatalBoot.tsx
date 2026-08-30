import { engine, type CliRenderer, type KeyEvent } from "@opentui/core";
import { _render, RendererContext } from "@opentui/solid";
import type { Accessor, JSX } from "solid-js";
import { createSignal, Show } from "solid-js";
import { errorText } from "../adapters/errors.ts";
import { borderChars, glyph } from "../theme/glyphs.ts";
import { tokens } from "../theme/tokens.ts";

/**
 * The boot-failure screen. Rendered before the keymap/theme exist — the token
 * signals carry usable defaults, and keys are bound straight off the renderer.
 */
function FatalBoot(props: { error: Accessor<string>; busy: Accessor<boolean> }): JSX.Element {
  return (
    <box
      position="absolute"
      left={0}
      right={0}
      top={0}
      bottom={0}
      backgroundColor={tokens.bg}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <box
        border
        borderStyle="single"
        customBorderChars={borderChars()}
        borderColor={tokens.del}
        backgroundColor={tokens.bgElev}
        flexDirection="column"
        padding={1}
        minWidth={40}
        maxWidth="90%"
      >
        <text fg={tokens.del}>{glyph("error") + " clarvis failed to start"}</text>
        <box paddingTop={1}>
          <text fg={tokens.fg}>{props.error()}</text>
        </box>
        <box paddingTop={1}>
          <text fg={tokens.muted}>
            {"the kernel could not boot " +
              glyph("emDash") +
              " fix the cause above and retry; once the app starts, Doctor lists checks and fixes"}
          </text>
        </box>
        <box paddingTop={1}>
          <text fg={props.busy() ? tokens.muted : tokens.accent}>
            {props.busy() ? "retrying" + glyph("ellipsis") : "[r] retry   [ctrl+c] quit"}
          </text>
        </box>
      </box>
    </box>
  );
}

/**
 * Mounts the fatal-boot screen on a bare renderer and drives it: [r] re-runs
 * `retry` until one attempt succeeds (then the screen unmounts and the promise
 * resolves `true`), and ctrl+c calls `quit` (expected to exit the process).
 * Renderer teardown resolves `false`, so boot orchestration cannot continue
 * while an asynchronous shutdown is still draining.
 */
export function runFatalBoot(opts: {
  renderer: CliRenderer;
  error: unknown;
  retry: () => Promise<void>;
  quit: () => void;
}): Promise<boolean> {
  const [message, setMessage] = createSignal(errorText(opts.error));
  const [busy, setBusy] = createSignal(false);
  const [visible, setVisible] = createSignal(true);
  engine.attach(opts.renderer);
  const dispose = _render(
    () => (
      <RendererContext.Provider value={opts.renderer}>
        <Show when={visible()}>
          <FatalBoot error={message} busy={busy} />
        </Show>
      </RendererContext.Provider>
    ),
    opts.renderer.root,
  );
  return new Promise((resolve) => {
    let closed = false;
    const close = (clear: boolean): void => {
      if (closed) return;
      closed = true;
      opts.renderer.keyInput.off("keypress", onKey);
      opts.renderer.off("destroy", onDestroy);
      if (clear) setVisible(false);
      dispose();
      resolve(clear);
    };
    const onDestroy = (): void => close(false);
    const onKey = (key: KeyEvent): void => {
      if (key.ctrl && key.name === "c") {
        key.preventDefault();
        key.stopPropagation();
        if (!busy()) opts.quit();
        return;
      }
      if (busy() || key.defaultPrevented) return;
      if (key.name !== "r") return;
      setBusy(true);
      void opts.retry().then(
        () => close(true),
        (e: unknown) => {
          if (closed) return;
          setMessage(errorText(e));
          setBusy(false);
        },
      );
    };
    opts.renderer.keyInput.prependListener("keypress", onKey);
    opts.renderer.once("destroy", onDestroy);
  });
}
