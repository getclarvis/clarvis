import { afterEach } from "bun:test";
import { DiffRenderable, MarkdownRenderable, type Renderable } from "@opentui/core";
import { testRender as renderWithOpenTui } from "@opentui/solid";

type RenderHandle = Awaited<ReturnType<typeof renderWithOpenTui>>;

const openRenders = new Set<RenderHandle>();

/**
 * Opens an OpenTUI Solid test renderer and registers teardown before the test
 * can make its first assertion. Tests may still destroy eagerly; the fallback
 * hook only closes handles that survived a thrown assertion or early return.
 */
export async function openRender(
  ...args: Parameters<typeof renderWithOpenTui>
): Promise<RenderHandle> {
  const rendered = await renderWithOpenTui(...args);
  openRenders.add(rendered);
  return rendered;
}

/** Waits until retained syntax surfaces have been visibly painted twice. */
export async function settleSyntaxSurfaces(rendered: RenderHandle): Promise<void> {
  let readyFrames = 0;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 8));
    await rendered.renderOnce();
    const surfaces: Renderable[] = [];
    const visit = (node: Renderable): void => {
      if (node instanceof DiffRenderable || node instanceof MarkdownRenderable) surfaces.push(node);
      for (const child of node.getChildren()) visit(child);
    };
    visit(rendered.renderer.root);
    if (surfaces.length === 0) return;
    readyFrames = surfaces.every((surface) => surface.opacity === 1) ? readyFrames + 1 : 0;
    if (readyFrames >= 2) return;
  }
  throw new Error("syntax surfaces did not reach a stable visible frame");
}

afterEach(() => {
  for (const rendered of openRenders) {
    if (!rendered.renderer.isDestroyed) rendered.renderer.destroy();
  }
  openRenders.clear();
});
