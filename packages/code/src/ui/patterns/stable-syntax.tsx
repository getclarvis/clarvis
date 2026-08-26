import {
  CodeRenderable,
  type DiffRenderable,
  type MarkdownRenderable,
  type Renderable,
} from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { batch, createEffect, createSignal, on, onCleanup, Show, untrack } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { diffColorProps, syntaxStyle } from "../../theme/syntax.ts";

interface SyntaxSnapshot {
  readonly content: string;
  readonly id: number;
  readonly ready: boolean;
  readonly streaming: boolean;
}

function codeDescendants(root: Renderable): CodeRenderable[] {
  const found: CodeRenderable[] = [];
  const visit = (node: Renderable): void => {
    if (node instanceof CodeRenderable) found.push(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return found;
}

function nextFrame(renderer: ReturnType<typeof useRenderer>): Promise<void> {
  if (renderer.isDestroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      renderer.off("frame", done);
      resolve();
    };
    renderer.on("frame", done);
    renderer.requestRender();
  });
}

/**
 * Waits until a hidden syntax renderable has painted every completed highlight into a frame.
 *
 * @remarks `CliRenderer.idle()` is insufficient here: it covers scheduled frames, not the
 *   Tree-sitter work started by `CodeRenderable.renderSelf()`. The first explicit frame starts
 *   that work. Each later pass awaits the public `highlightingDone` contract and paints its result
 *   while the owning layer is still transparent. Final content can then be revealed atomically.
 */
async function waitForSyntaxFrame(
  root: Renderable,
  current: () => boolean,
  renderer: ReturnType<typeof useRenderer>,
): Promise<void> {
  await nextFrame(renderer);
  while (current() && !renderer.isDestroyed && !root.isDestroyed) {
    const pending = codeDescendants(root).filter((renderable) => renderable.isHighlighting);
    if (pending.length === 0) {
      await nextFrame(renderer);
      return;
    }
    await Promise.all(pending.map((renderable) => renderable.highlightingDone));
    if (!current() || renderer.isDestroyed || root.isDestroyed) return;
    await nextFrame(renderer);
  }
}

function snapshot(id: number, content: string, streaming: boolean, ready: boolean): SyntaxSnapshot {
  return { content, id, ready, streaming };
}

/**
 * Markdown surface that preserves the visible streaming tree until its final replacement is ready.
 *
 * @remarks OpenTUI finalizes a Markdown renderable by force-refreshing its internal blocks. That
 *   correctly reparses the unstable suffix, but it also discards already painted inline styling
 *   before asynchronous Tree-sitter highlighting completes. This component prepares the final tree
 *   at zero opacity, waits for its descendant highlights, and swaps the two retained slots in one
 *   Solid batch. At most two Markdown trees exist, and only during settlement.
 */
export function StableMarkdown(props: {
  conceal?: boolean;
  content: string;
  internalBlockMode?: "coalesced" | "top-level";
  marginTop?: number;
  streaming: boolean;
}): JSX.Element {
  const renderer = useRenderer();
  let nextId = 1;
  const initialStreaming = untrack(() => props.streaming);
  const initialContent = untrack(() => props.content);
  const [activeSlot, setActiveSlot] = createSignal<0 | 1>(0);
  const [slot0, setSlot0] = createSignal<SyntaxSnapshot | undefined>(
    snapshot(nextId++, initialContent, initialStreaming, initialStreaming),
  );
  const [slot1, setSlot1] = createSignal<SyntaxSnapshot>();
  const [ref0, setRef0] = createSignal<MarkdownRenderable>();
  const [ref1, setRef1] = createSignal<MarkdownRenderable>();
  let disposed = false;

  const slots = [slot0, slot1] as const;
  const setters = [setSlot0, setSlot1] as const;
  const refs = [ref0, ref1] as const;

  const prepare = (slot: 0 | 1, value: SyntaxSnapshot, root: MarkdownRenderable): void => {
    const current = (): boolean => !disposed && slots[slot]()?.id === value.id;
    const commit = (): void => {
      if (!current()) return;
      batch(() => {
        setters[slot]((existing) =>
          existing?.id === value.id ? { ...existing, ready: true } : existing,
        );
        const previous = activeSlot();
        setActiveSlot(slot);
        if (previous !== slot) setters[previous](undefined);
      });
    };
    void waitForSyntaxFrame(root, current, renderer).then(commit, commit);
  };

  for (const slot of [0, 1] as const) {
    createEffect(() => {
      const value = slots[slot]();
      const root = refs[slot]();
      if (!value || value.streaming || value.ready || !root) return;
      prepare(slot, value, root);
    });
  }

  createEffect(
    on(
      [() => props.content, () => props.streaming],
      ([content, streaming]) => {
        const active = activeSlot();
        const current = slots[active]();
        if (streaming) {
          const inactive = active === 0 ? 1 : 0;
          batch(() => {
            setters[inactive](undefined);
            setters[active](snapshot(nextId++, content, true, true));
          });
          return;
        }
        if (current?.content === content && !current.streaming && current.ready) return;
        const target = active === 0 ? 1 : 0;
        setters[target](snapshot(nextId++, content, false, false));
      },
      { defer: true },
    ),
  );

  onCleanup(() => {
    disposed = true;
  });

  const layer = (slot: 0 | 1, value: Accessor<SyntaxSnapshot>): JSX.Element => (
    <box
      width="100%"
      height={activeSlot() === slot ? undefined : refs[activeSlot()]()?.height}
      minWidth={0}
      position={activeSlot() === slot ? "relative" : "absolute"}
      left={activeSlot() === slot ? undefined : 0}
      top={activeSlot() === slot ? undefined : 0}
      zIndex={activeSlot() === slot ? 1 : 0}
      opacity={activeSlot() === slot && value().ready ? 1 : 0}
    >
      <markdown
        ref={slot === 0 ? setRef0 : setRef1}
        content={value().content}
        streaming={value().streaming}
        conceal={props.conceal}
        internalBlockMode={props.internalBlockMode}
        syntaxStyle={syntaxStyle()}
        width="100%"
        height={activeSlot() === slot ? undefined : refs[activeSlot()]()?.height}
        minWidth={0}
        marginTop={props.marginTop}
        tableOptions={{ widthMode: "content", wrapMode: "word", style: "grid" }}
      />
    </box>
  );

  return (
    <box position="relative" width="100%" minWidth={0} flexDirection="column">
      <Show when={slot0()}>{(value: Accessor<SyntaxSnapshot>) => layer(0, value)}</Show>
      <Show when={slot1()}>{(value: Accessor<SyntaxSnapshot>) => layer(1, value)}</Show>
    </box>
  );
}

/**
 * Finalized diff surface that becomes visible only after its syntax children have settled.
 *
 * @remarks Tool diffs are immutable transcript artifacts. Keeping the intrinsic mounted for a
 *   stable `diff` value prevents sibling activity from restarting its parser; hiding its first
 *   paint prevents a newly completed tool from exposing OpenTUI's unhighlighted fallback frame.
 *   This boundary also owns line-ending normalization. A bare carriage return is a cursor command
 *   to the text buffer but not to the unified-diff parser, so allowing one through desynchronizes
 *   the gutter and can hide genuine addition markers.
 */
export function StableDiff(props: {
  diff: string;
  filetype?: string;
  showLineNumbers?: boolean;
  wrapMode?: "word" | "char" | "none";
}): JSX.Element {
  const renderer = useRenderer();
  const normalized = (): string => props.diff.replace(/\r\n/g, "\n").replace(/\r/g, "");
  const [ready, setReady] = createSignal(false);
  const [root, setRoot] = createSignal<DiffRenderable>();
  let revision = 0;
  let disposed = false;

  createEffect(
    on([normalized, () => props.filetype, () => props.wrapMode, root], () => {
      const captured = ++revision;
      setReady(false);
      const renderable = root();
      if (!renderable) return;
      const reveal = (): void => {
        if (!disposed && captured === revision) setReady(true);
      };
      void waitForSyntaxFrame(renderable, () => !disposed && captured === revision, renderer).then(
        reveal,
        reveal,
      );
    }),
  );

  onCleanup(() => {
    disposed = true;
    revision += 1;
  });

  return (
    <diff
      ref={(value: DiffRenderable) => {
        setRoot(value);
      }}
      diff={normalized()}
      filetype={props.filetype}
      syntaxStyle={syntaxStyle()}
      wrapMode={props.wrapMode}
      showLineNumbers={props.showLineNumbers}
      opacity={ready() ? 1 : 0}
      {...diffColorProps()}
    />
  );
}
