import {
  CodeRenderable,
  DiffRenderable,
  type MarkdownRenderable,
  type Renderable,
} from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import {
  batch,
  createContext,
  createEffect,
  createSignal,
  on,
  onCleanup,
  Show,
  untrack,
  useContext,
} from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { diagnosticEvent } from "../../core/diagnostic-events.ts";
import { diffColorProps, syntaxStyle } from "../../theme/syntax.ts";

interface SyntaxSnapshot {
  readonly content: string;
  readonly id: number;
  readonly internalBlockMode?: "coalesced" | "top-level";
  readonly ready: boolean;
  readonly streaming: boolean;
}

interface SyntaxPublicationRegistration {
  ready(): void;
  dispose(): void;
}

interface SyntaxPublicationCoordinator {
  allowUnsettled(): boolean;
  register(): SyntaxPublicationRegistration;
}

const SyntaxPublicationContext = createContext<SyntaxPublicationCoordinator>();
const pendingRendererFrames = new WeakMap<object, Promise<void>>();

/** Settled OpenTUI dimensions observed identically across two completed frames. */
export interface SyntaxPublicationMeasurement {
  readonly columns: number;
  readonly rows: number;
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
      pendingRendererFrames.delete(renderer);
      resolve();
    };
    renderer.on("frame", done);
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

export async function waitForStableDimensions(
  root: Renderable,
  current: () => boolean,
  renderer: ReturnType<typeof useRenderer>,
): Promise<SyntaxPublicationMeasurement | null> {
  let previous: SyntaxPublicationMeasurement | null = null;
  while (current() && !renderer.isDestroyed && !root.isDestroyed) {
    await nextFrame(renderer);
    if (!current() || renderer.isDestroyed || root.isDestroyed) return null;
    const observed = {
      columns: Math.max(0, Math.trunc(root.width)),
      rows: Math.max(0, Math.trunc(root.height)),
    } satisfies SyntaxPublicationMeasurement;
    if (
      observed.columns > 0 &&
      observed.rows > 0 &&
      previous?.columns === observed.columns &&
      previous.rows === observed.rows
    )
      return observed;
    previous = observed;
  }
  return null;
}

/**
 * Disables parser work on a still-hidden recovery candidate before its first publication.
 *
 * @remarks This uses only OpenTUI's public `filetype` setters. A visible owner never takes this
 * path: it retains its painted renderables and waits on the public `highlightingDone` contract.
 */
async function freezeUnsettledSyntax(
  root: Renderable,
  current: () => boolean,
  renderer: ReturnType<typeof useRenderer>,
): Promise<void> {
  await nextFrame(renderer);
  if (!current()) return;
  const diffs: DiffRenderable[] = [];
  const visitDiffs = (node: Renderable): void => {
    if (node instanceof DiffRenderable) diffs.push(node);
    for (const child of node.getChildren()) visitDiffs(child);
  };
  visitDiffs(root);
  for (const diff of diffs) diff.filetype = undefined;
  for (const code of codeDescendants(root)) code.filetype = undefined;
  await nextFrame(renderer);
  if (!current()) return;
  for (const code of codeDescendants(root)) code.filetype = undefined;
  await nextFrame(renderer);
}

/**
 * Holds an owner invisible until all syntax descendants have highlighted and painted a ready frame.
 *
 * @remarks Descendants register synchronously while the owner mounts. The boundary then waits for
 * every registered surface plus its own final frame before notifying the append-only history owner.
 */
export function SyntaxPublicationBoundary(props: {
  allowUnsettled?: boolean;
  children: JSX.Element;
  diagnosticId?: string;
  measurementRevision?: number;
  onReady: (
    measurement: SyntaxPublicationMeasurement,
    measurementRevision: number | undefined,
  ) => void;
}): JSX.Element {
  const renderer = useRenderer();
  const [root, setRoot] = createSignal<Renderable>();
  const [revision, setRevision] = createSignal(0);
  let registrations = 0;
  let readyRegistrations = 0;
  let completionRevision = 0;
  let completed = false;
  let disposed = false;
  let hasObservedMeasurementRevision = false;
  let observedMeasurementRevision: number | undefined;
  let pendingSignature = "";

  const coordinator: SyntaxPublicationCoordinator = {
    allowUnsettled: () => props.allowUnsettled === true,
    register() {
      registrations += 1;
      setRevision((value) => value + 1);
      let ready = false;
      let active = true;
      return {
        ready() {
          if (!active || ready) return;
          ready = true;
          readyRegistrations += 1;
          setRevision((value) => value + 1);
        },
        dispose() {
          if (!active) return;
          active = false;
          registrations -= 1;
          if (ready) readyRegistrations -= 1;
          setRevision((value) => value + 1);
        },
      };
    },
  };

  createEffect(() => {
    const measurementRevision = props.measurementRevision;
    if (hasObservedMeasurementRevision && measurementRevision !== observedMeasurementRevision) {
      completed = false;
      completionRevision += 1;
    }
    hasObservedMeasurementRevision = true;
    observedMeasurementRevision = measurementRevision;
    revision();
    const owner = root();
    if (
      measurementRevision === undefined ||
      owner === undefined ||
      completed ||
      renderer.isDestroyed
    )
      return;
    if (readyRegistrations !== registrations) {
      const signature = `${readyRegistrations}:${registrations}`;
      if (signature !== pendingSignature) {
        pendingSignature = signature;
        diagnosticEvent("transcript.syntax.pending", {
          batch_id: props.diagnosticId,
          ready_registrations: readyRegistrations,
          registrations,
          columns: owner.width,
          rows: owner.height,
        });
      }
      return;
    }
    pendingSignature = "";
    const captured = ++completionRevision;
    const measuredRevision = observedMeasurementRevision;
    const current = (): boolean =>
      !disposed &&
      !completed &&
      captured === completionRevision &&
      readyRegistrations === registrations;
    const finish = async (): Promise<void> => {
      const startedAt = performance.now();
      diagnosticEvent("transcript.syntax.started", {
        batch_id: props.diagnosticId,
        registrations,
        columns: owner.width,
        rows: owner.height,
      });
      try {
        if (props.allowUnsettled === true) await freezeUnsettledSyntax(owner, current, renderer);
        else await waitForSyntaxFrame(owner, current, renderer);
      } catch {
        if (!current()) return;
      }
      diagnosticEvent("transcript.syntax.painted", {
        batch_id: props.diagnosticId,
        duration_ms: Math.round(performance.now() - startedAt),
        columns: owner.width,
        rows: owner.height,
      });
      const measurement = await waitForStableDimensions(owner, current, renderer);
      if (!current() || measurement === null) return;
      completed = true;
      diagnosticEvent("transcript.syntax.measured", {
        batch_id: props.diagnosticId,
        duration_ms: Math.round(performance.now() - startedAt),
        columns: measurement.columns,
        rows: measurement.rows,
      });
      props.onReady(measurement, measuredRevision);
    };
    finish().catch(() => undefined);
  });

  onCleanup(() => {
    disposed = true;
    completionRevision += 1;
  });

  return (
    <SyntaxPublicationContext.Provider value={coordinator}>
      <box ref={setRoot} flexDirection="column" width="100%" minWidth={0}>
        {props.children}
      </box>
    </SyntaxPublicationContext.Provider>
  );
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
 *   later syntax concealment can change only the mutable rows, not pull earlier transcript rows
 *   back down. A response epoch resets that view-local reservation.
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
  const publication = useContext(SyntaxPublicationContext);
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
  const publicationRegistration = initialStreaming ? undefined : publication?.register();

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
      publicationRegistration?.ready();
    };
    const pending =
      publication?.allowUnsettled() === true
        ? nextFrame(renderer)
        : waitForSyntaxFrame(root, current, renderer);
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
    publicationRegistration?.dispose();
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
      minHeight={liveHeightFloor()}
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
  const publication = useContext(SyntaxPublicationContext);
  const publicationRegistration = publication?.register();
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
          publicationRegistration?.ready();
        }
      };
      const current = (): boolean => !disposed && captured === revision;
      const pending =
        publicationRegistration === undefined || publication?.allowUnsettled() !== true
          ? waitForSyntaxFrame(renderable, current, renderer)
          : nextFrame(renderer);
      void pending.then(reveal, reveal);
    }),
  );

  onCleanup(() => {
    disposed = true;
    revision += 1;
    publicationRegistration?.dispose();
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
