import {
  ScrollBoxRenderable,
  type MouseEvent,
  type RenderContext,
  type ScrollBoxOptions,
} from "@opentui/core";
import { extend } from "@opentui/solid";

/** Options for committed history's boundary-aware native ScrollBox. */
export interface TranscriptScrollBoxOptions extends ScrollBoxOptions {
  onVerticalScrollIntent?: (direction: "up" | "down") => void;
}

/** Preserves native wheel scrolling and applies physical anchor deltas before paint. */
export class TranscriptScrollBoxRenderable extends ScrollBoxRenderable {
  #onVerticalScrollIntent: ((direction: "up" | "down") => void) | undefined;
  #pendingPhysicalScrollDelta = 0;

  constructor(ctx: RenderContext, options: TranscriptScrollBoxOptions) {
    const { onVerticalScrollIntent, ...scrollBoxOptions } = options;
    super(ctx, scrollBoxOptions);
    this.#onVerticalScrollIntent = onVerticalScrollIntent;
    const onContentSizeChange = this.content.onSizeChange;
    this.content.onSizeChange = () => {
      onContentSizeChange?.();
      this.#applyPendingPhysicalScrollDelta(true);
    };
  }

  set onVerticalScrollIntent(callback: ((direction: "up" | "down") => void) | undefined) {
    this.#onVerticalScrollIntent = callback;
  }

  /** Scroll correction still waiting for the physical range that will admit it. */
  get pendingPhysicalScrollDelta(): number {
    return this.#pendingPhysicalScrollDelta;
  }

  /** Queue an exact row correction before publishing the geometry that requires it. */
  queuePhysicalScrollDelta(rows: number): void {
    if (!Number.isFinite(rows)) return;
    this.#pendingPhysicalScrollDelta += Math.trunc(rows);
  }

  /** Discard a correction whose owning navigation was explicitly replaced. */
  clearPhysicalScrollDelta(): void {
    this.#pendingPhysicalScrollDelta = 0;
  }

  protected override onUpdate(deltaTime: number): void {
    super.onUpdate(deltaTime);
    if (this.#pendingPhysicalScrollDelta === 0) return;
    const computedHeight = Math.max(1, this.content.getLayoutNode().getComputedLayout().height);
    const contentWillResize = computedHeight !== this.content.height;
    this.#applyPendingPhysicalScrollDelta(!contentWillResize);
  }

  protected override onMouseEvent(event: MouseEvent): void {
    const direction = event.scroll?.direction;
    if (
      event.type !== "scroll" ||
      event.modifiers.shift ||
      (direction !== "up" && direction !== "down") ||
      this.#onVerticalScrollIntent === undefined
    ) {
      super.onMouseEvent(event);
      return;
    }

    super.onMouseEvent(event);
    this.#onVerticalScrollIntent(direction);
  }

  #applyPendingPhysicalScrollDelta(finalAttempt: boolean): void {
    const requested = this.#pendingPhysicalScrollDelta;
    if (requested === 0) return;
    const before = this.scrollTop;
    this.scrollBy({ x: 0, y: requested });
    this.#pendingPhysicalScrollDelta -= this.scrollTop - before;
    if (finalAttempt) this.#pendingPhysicalScrollDelta = 0;
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    transcript_scrollbox: typeof TranscriptScrollBoxRenderable;
  }
}

extend({ transcript_scrollbox: TranscriptScrollBoxRenderable });
