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
  readonly internalBlockMode?: "coalesced" | "top-level";
  readonly ready: boolean;
  readonly streaming: boolean;
}

const pendingRendererFrames = new WeakMap<object, Promise<void>>();

function codeDescendants(root: Renderable): CodeRenderable[] {
  const found: CodeRenderable[] = [];
  const visit = (node: Renderable): void => {
    if (node instanceof CodeRenderable) found.push(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return found;
}

/**
 * Await one fresh OpenTUI frame without depending on an external invalidation.
 *
 * @remarks A one-shot `CliRenderer` clears its internal `updateScheduled` latch in the async
 * continuation after emitting `frame`. A promise resumed by that event runs first, so requesting
 * the next render synchronously is coalesced into the still-active latch and no frame follows.
 * Deferring one microtask hands scheduling back to OpenTUI before requesting the confirming frame.
 */
function nextFrame(renderer: ReturnType<typeof useRenderer>): Promise<void> {
  if (renderer.isDestroyed) return Promise.resolve();
  const existing = pendingRendererFrames.get(renderer);
  if (existing !== undefined) return existing;
  let observed = false;
  const pending = new Promise<void>((resolve) => {
    const done = (): void => {
      observed = true;
      renderer.off("frame", done);
      renderer.off("destroy", done);
      pendingRendererFrames.delete(renderer);
      resolve();
    };
    renderer.on("frame", done);
    renderer.on("destroy", done);
    queueMicrotask(() => {
      if (!observed && !renderer.isDestroyed) renderer.requestRender();
    });
  });
  pendingRendererFrames.set(renderer, pending);
  return pending;
}

/**
 * Waits until a hidden syntax renderable has painted every completed highlight into a frame.
 *
 * @remarks `CliRenderer.idle()` is insufficient here: it covers scheduled frames, not the
 *   Tree-sitter work started by `CodeRenderable.renderSelf()`. The first explicit frame starts
 *   that work. Each later pass awaits the public `highlightingDone` contract and paints its result
 *   while the owning layer is still transparent. Final content can then be revealed atomically.
 */
export async function waitForSyntaxFrame(
  root: Renderable,
  current: () => boolean,
  renderer: ReturnType<typeof useRenderer>,
): Promise<void> {
  await nextFrame(renderer);
  for (
    let attempt = 0;
    attempt < 3 && current() && !renderer.isDestroyed && !root.isDestroyed;
    attempt++
  ) {
    const pending = codeDescendants(root).filter((renderable) => renderable.isHighlighting);
    if (pending.length === 0) {
      await nextFrame(renderer);
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(pending.map((renderable) => renderable.highlightingDone)),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 250);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    if (!current() || renderer.isDestroyed || root.isDestroyed) return;
    await nextFrame(renderer);
  }
}

function snapshot(
  id: number,
  content: string,
  streaming: boolean,
  ready: boolean,
  internalBlockMode?: "coalesced" | "top-level",
): SyntaxSnapshot {
  return { content, id, ready, streaming, internalBlockMode };
}

/**
 * Markdown surface that preserves the visible streaming tree until its final replacement is ready.
 *
 * @remarks OpenTUI finalizes a Markdown renderable by force-refreshing its internal blocks. That
 *   correctly reparses the unstable suffix, but it also discards already painted inline styling
 *   before asynchronous Tree-sitter highlighting completes. This component prepares the final tree
 *   at zero opacity, waits for its descendant highlights, and swaps the two retained slots in one
 *   Solid batch. At most two Markdown trees exist, and only during settlement. While content is
 *   streaming, a row high-water mark reserves any height an unstable trailing token already used;
 *   later syntax concealment cannot pull earlier transcript rows back down while that tree remains
 *   mutable. After the atomic swap, the final tree's height is reset to `auto` so a short answer
 *   cannot keep the streaming overlay's row count as blank space above the run outcome. A response
 *   epoch also resets the reservation while streaming continues.
 */
export function StableMarkdown(props: {
  conceal?: boolean;
  content: string;
  geometryEpoch?: number;
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
    snapshot(
      nextId++,
      initialContent,
      initialStreaming,
      initialStreaming,
      untrack(() => props.internalBlockMode),
    ),
  );
  const [slot1, setSlot1] = createSignal<SyntaxSnapshot>();
  const [ref0, setRef0] = createSignal<MarkdownRenderable>();
  const [ref1, setRef1] = createSignal<MarkdownRenderable>();
  const [liveHeightFloor, setLiveHeightFloor] = createSignal(0);
  let observedGeometryEpoch = untrack(() => props.geometryEpoch);
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
        if (!value.streaming) setLiveHeightFloor(0);
        const previous = activeSlot();
        setActiveSlot(slot);
        if (previous !== slot) setters[previous](undefined);
      });
      if (!value.streaming) {
        queueMicrotask(() => {
          const root = refs[slot]();
          if (disposed || !root || slots[slot]()?.id !== value.id) return;
          root.height = "auto";
          const owner = root.parent;
          if (owner !== undefined && owner !== null) owner.height = "auto";
          renderer.requestRender();
        });
      }
    };
    const pending = waitForSyntaxFrame(root, current, renderer);
    void pending.then(commit, commit);
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
      [
        () => props.content,
        () => props.streaming,
        () => props.internalBlockMode,
        () => props.geometryEpoch,
      ],
      ([content, streaming, internalBlockMode, geometryEpoch]) => {
        const active = activeSlot();
        const current = slots[active]();
        if (geometryEpoch !== observedGeometryEpoch) {
          observedGeometryEpoch = geometryEpoch;
          setLiveHeightFloor(0);
        } else if (streaming || current?.streaming) {
          const visibleRows = Math.max(0, Math.ceil(refs[active]()?.height ?? 0));
          if (visibleRows > 0) setLiveHeightFloor((existing) => Math.max(existing, visibleRows));
        }
        if (streaming) {
          const inactive = active === 0 ? 1 : 0;
          batch(() => {
            setters[inactive](undefined);
            setters[active](snapshot(nextId++, content, true, true, internalBlockMode));
          });
          return;
        }
        if (
          current?.content === content &&
          current.internalBlockMode === internalBlockMode &&
          !current.streaming &&
          current.ready
        )
          return;
        const target = active === 0 ? 1 : 0;
        setters[target](snapshot(nextId++, content, false, false, internalBlockMode));
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
        internalBlockMode={value().internalBlockMode}
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
    <box
      position="relative"
      width="100%"
      minWidth={0}
      minHeight={slots[activeSlot()]()?.streaming ? liveHeightFloor() : 0}
      flexDirection="column"
    >
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
        if (!disposed && captured === revision) {
          setReady(true);
        }
      };
      const current = (): boolean => !disposed && captured === revision;
      const pending = waitForSyntaxFrame(renderable, current, renderer);
      void pending.then(reveal, reveal);
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
