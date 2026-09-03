import type { InputRenderable } from "@opentui/core";
import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { tokens } from "../theme/tokens.ts";
import { borderChars, glyph } from "../theme/glyphs.ts";
import { ruleColor } from "../theme/surfaces.ts";
import { BrandBanner } from "./Splash.tsx";

/** Rows required by the fixed startup chrome plus the complete eight-row Clarvis banner. */
const STARTUP_SPLASH_MIN_ROWS = 16;

/** Text accepted by the startup composer before the complete application graph is ready. */
export interface StartupComposerSnapshot {
  draft: string;
  submission?: string;
}

/** Exact input disposition when the complete composer replaces the startup shell. */
export interface StartupComposerHandoff {
  submission?: string;
  initialDraft?: string;
}

/**
 * Preserve startup input unless the complete runtime can admit its queued submission now.
 *
 * @param snapshot - Single-consumer snapshot from the startup composer.
 * @param runnable - Whether the active Agent Profile can start a run in this runtime.
 * @returns Either one admitted submission or one exact draft for the complete composer.
 */
export function resolveStartupComposerHandoff(
  snapshot: StartupComposerSnapshot,
  runnable: boolean,
): StartupComposerHandoff {
  if (snapshot.submission !== undefined && runnable) return { submission: snapshot.submission };
  const initialDraft = snapshot.submission ?? snapshot.draft;
  return initialDraft.length === 0 ? {} : { initialDraft };
}

/** Host-owned bridge that keeps startup input alive across the root's view replacement. */
export interface StartupComposerState {
  bind(input: InputRenderable): void;
  unbind(input: InputRenderable): void;
  queue(text: string): boolean;
  take(): StartupComposerSnapshot;
}

/** Create the single-consumer input bridge shared by the lightweight entrypoint and runtime. */
export function createStartupComposerState(): StartupComposerState {
  let input: InputRenderable | undefined;
  let draft = "";
  let submission: string | undefined;
  let consumed = false;
  return {
    bind(next) {
      input = next;
      if (draft.length > 0) {
        next.setText(draft);
        next.gotoBufferEnd();
      }
      next.onContentChange = () => {
        draft = next.plainText ?? "";
      };
    },
    unbind(current) {
      if (input !== current) return;
      draft = current.plainText ?? draft;
      input = undefined;
    },
    queue(text) {
      if (consumed || submission !== undefined || text.trim().length === 0) return false;
      draft = text;
      submission = text;
      input?.blur();
      return true;
    },
    take() {
      if (consumed) return { draft: "" };
      consumed = true;
      draft = input?.plainText ?? draft;
      return { draft, ...(submission === undefined ? {} : { submission }) };
    },
  };
}

/** Immediately usable composer shown while the workspace runtime connects. */
export function StartupComposer(props: {
  state: StartupComposerState;
  acceptsInput: boolean;
  version: string;
}): JSX.Element {
  const dims = useTerminalDimensions();
  let input: InputRenderable | undefined;
  const [queued, setQueued] = createSignal(false);

  onMount(() => {
    if (props.acceptsInput) input?.focus();
  });
  onCleanup(() => {
    if (input !== undefined) props.state.unbind(input);
  });

  const submit = (): void => {
    if (input === undefined || !props.acceptsInput) return;
    setQueued(props.state.queue(input.plainText ?? ""));
  };

  return (
    <box
      position="absolute"
      left={0}
      right={0}
      top={0}
      bottom={0}
      backgroundColor={tokens.bg}
      flexDirection="column"
    >
      <box flexDirection="column" flexShrink={0} height={dims().height >= 8 ? 2 : 1}>
        <box height={1} flexDirection="row" paddingLeft={1} flexShrink={0}>
          <text flexShrink={0} wrapMode="none">
            <b>
              <span style={{ fg: tokens.accent }}>{"/"}</span>
              <span style={{ fg: tokens.fg }}>{" Clarvis"}</span>
            </b>
          </text>
          <text fg={tokens.muted} flexShrink={1} minWidth={0} wrapMode="none" truncate>
            {` ${glyph("separator")} code ${glyph("separator")} starting`}
          </text>
          <box flexGrow={1} minWidth={0} />
          <text fg={tokens.muted} flexShrink={0} paddingLeft={1} wrapMode="none">
            {`v${props.version}`}
          </text>
        </box>
        <Show when={dims().height >= 8}>
          <text fg={ruleColor()} wrapMode="none" truncate>
            {glyph("horizontal").repeat(Math.max(1, dims().width))}
          </text>
        </Show>
      </box>

      <box
        flexGrow={1}
        minHeight={0}
        flexDirection="column"
        justifyContent="center"
        alignItems="center"
      >
        <Show when={dims().height >= 8}>
          <BrandBanner
            width={() => dims().width}
            compact={() => dims().height < STARTUP_SPLASH_MIN_ROWS}
          />
        </Show>
        <text fg={queued() ? tokens.accent2 : tokens.muted} wrapMode="none" truncate>
          {queued()
            ? `task queued ${glyph("separator")} connecting workspace${glyph("ellipsis")}`
            : `connecting workspace${glyph("ellipsis")}`}
        </text>
      </box>

      <box flexDirection="column" flexShrink={0} marginLeft={1} marginRight={1} marginBottom={1}>
        <box
          height={3}
          paddingLeft={1}
          paddingRight={1}
          border
          borderStyle="rounded"
          customBorderChars={borderChars()}
          borderColor={queued() ? tokens.accent2 : tokens.muted}
          alignItems="center"
        >
          <input
            ref={(element: InputRenderable) => {
              input = element;
              props.state.bind(element);
            }}
            placeholder={
              props.acceptsInput
                ? `Queue a task${glyph("ellipsis")}  (/ commands after connection)`
                : `Restoring session${glyph("ellipsis")}`
            }
            placeholderColor={tokens.muted}
            textColor={tokens.fg}
            focusedTextColor={tokens.fg}
            onSubmit={submit}
          />
        </box>
        <text fg={tokens.muted} height={1} paddingLeft={1} wrapMode="none" truncate>
          {queued()
            ? "Task accepted; it will start as soon as the workspace is ready."
            : props.acceptsInput
              ? "Type now; Enter queues the task while extensions finish loading."
              : "The composer unlocks after the saved session is restored."}
        </text>
      </box>
    </box>
  );
}
