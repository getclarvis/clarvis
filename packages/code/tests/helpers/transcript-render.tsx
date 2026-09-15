import { createRoot, createSignal } from "solid-js";
import { createMutable } from "solid-js/store";
import type { Renderable, ScrollBoxRenderable } from "@opentui/core";
import type { ActivityStore } from "../../src/adapters/activity-store.ts";
import { createTranscriptStore } from "../../src/adapters/store.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { TranscriptRegion } from "../../src/views/app/TranscriptRegion.tsx";
import type { TranscriptViewportHandle as TranscriptViewportHandle } from "../../src/views/transcript/TranscriptViewport.tsx";
import { createTranscriptState } from "../../src/views/transcript-state.ts";
import { createFakeKeymap } from "./fake-keymap.ts";
import { openRender } from "./tracked-render.ts";

/** Production transcript region with deterministic host ports and real native layout. */
export async function openTranscript(width = 120, height = 32) {
  const owned = createRoot((dispose) => {
    const store = createTranscriptStore();
    const activity = createMutable({
      subagents: [],
      plan: null,
      usage: null,
      context: null,
    }) as unknown as ActivityStore;
    const transcript = createTranscriptState({
      nodes: () => store.nodes,
      subagents: () => activity.subagents.map(({ id, order, title }) => ({ id, order, title })),
      notify: () => {},
      defaultFolded: (key) => store.defaultFolded(key),
    });
    const [split, setSplit] = createSignal(false);
    const [dimensions, setDimensions] = createSignal({ width, height });
    return { store, activity, transcript, split, setSplit, dimensions, setDimensions, dispose };
  });
  const { store, activity, transcript, split, setSplit, dimensions } = owned;
  let history: TranscriptViewportHandle;
  let scrollbox: ScrollBoxRenderable;
  const rendered = await openRender(
    () => (
      <TranscriptRegion
        store={store}
        transcript={transcript}
        activity={activity}
        interaction={
          {
            keymap: createFakeKeymap().keymap,
            pushOverlayContext: () => {},
            popOverlayContext: () => {},
            syncContext: () => {},
          } as unknown as Interaction
        }
        run={{ elicit: () => null, resolveElicit: () => {}, workflowActivity: () => null }}
        layout={{
          mode: () => "wide",
          sidebarVisible: split,
          sidebarWidth: () => 28,
          drawerOpen: () => false,
          contentInset: () => 0,
          width: () => dimensions().width,
          height: () => dimensions().height,
        }}
        contextWindow={() => 32768}
        agent={() => "coder"}
        model={() => "fixture"}
        openPlan={() => {}}
        notify={() => {}}
        onScrollbox={(value) => {
          scrollbox = value;
        }}
        onHistoryHandle={(value) => {
          if (value) history = value;
        }}
      />
    ),
    { width, height },
  );
  rendered.renderer.once("destroy", owned.dispose);
  return {
    store,
    transcript,
    activity,
    rendered,
    setSplit,
    resize(width: number, height: number) {
      owned.setDimensions({ width, height });
      rendered.resize(width, height);
    },
    history: () => history!,
    scrollbox: () => scrollbox!,
    async frames(count = 3) {
      for (let frame = 0; frame < count; frame++) await rendered.renderOnce();
    },
  };
}

/** Walk the mounted native tree, including nodes culled from painting. */
export function transcriptRenderables(root: Renderable): Renderable[] {
  return [root, ...root.getChildren().flatMap(transcriptRenderables)];
}
