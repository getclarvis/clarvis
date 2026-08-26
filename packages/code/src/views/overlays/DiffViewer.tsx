import { onCleanup, onMount, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { TranscriptToolNode } from "../../adapters/store.ts";
import { toolLabel } from "../../adapters/tool-identity.ts";
import type { Interaction } from "../../keys/interaction.ts";
import { resolveToolRenderer } from "../tools/registry.tsx";
import { registerScrollKeys } from "../../ui/patterns/list-navigation.ts";
import { PageFrame } from "../PageFrame.tsx";
import { EmptyHint } from "../config/view-host.tsx";
import { glyph } from "../../theme/glyphs.ts";
import { scrollbarOptions } from "../../theme/surfaces.ts";
import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";

/**
 * A full-screen page rendering a single transcript tool node's diff via the
 * shared tool-result renderer, for when the inline block isn't enough room.
 */
export function DiffViewer(props: {
  interaction: Interaction;
  node: Accessor<TranscriptToolNode | null>;
  active?: Accessor<boolean>;
}): JSX.Element {
  let scrollEl: ScrollBoxRenderable | undefined;
  onMount(() => {
    const off = registerScrollKeys(
      props.interaction.keymap,
      () => scrollEl,
      undefined,
      [],
      props.active ? "overlay==diff" : undefined,
      props.active ? reactiveMatcherFromSignal(props.active) : undefined,
    );
    onCleanup(off);
  });
  const subtitle = (): string | undefined => {
    const n = props.node();
    if (!n) return undefined;
    /**
     * Name the file, not only the tool.
     *
     * @remarks The inline block a reader opens this page *from* shows the path;
     * the full-screen view dropped it and said only `edit_file`, so the one
     * surface with room for the whole diff was the one that did not say what
     * the diff was of.
     */
    const path = typeof n.args?.path === "string" ? n.args.path : undefined;
    const label = toolLabel(n.mcpName, n.toolName);
    return path ? `${label} ${glyph("separator")} ${path}` : label;
  };
  return (
    <PageFrame title="Diff" subtitle={subtitle()} interaction={props.interaction}>
      <scrollbox
        ref={(el: ScrollBoxRenderable) => (scrollEl = el)}
        flexGrow={1}
        verticalScrollbarOptions={scrollbarOptions()}
      >
        <Show
          when={props.node()}
          fallback={
            <EmptyHint
              text="no diff in the transcript yet"
              icon="info"
              hint="run a file-editing tool to populate one"
            />
          }
        >
          {(n: Accessor<TranscriptToolNode>) =>
            resolveToolRenderer(
              n().mcpName ?? "",
              n().toolName ?? "",
            )({
              mcpName: n().mcpName ?? "",
              toolName: n().toolName ?? "",
              arguments: n().args ?? {},
              result: n().result ?? "",
              diff: n().diff,
              error: n().error ?? null,
              status: n().status,
              full: true,
              wrap: true,
            })
          }
        </Show>
      </scrollbox>
    </PageFrame>
  );
}
