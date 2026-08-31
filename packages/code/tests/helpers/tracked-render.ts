import { onTestFinished } from "bun:test";
import { CodeRenderable, DiffRenderable, MarkdownRenderable, type Renderable } from "@opentui/core";
import { testRender as renderWithOpenTui } from "@opentui/solid";

type RenderHandle = Awaited<ReturnType<typeof renderWithOpenTui>>;

/**
 * Opens an OpenTUI Solid test renderer and registers teardown before the test
 * can make its first assertion. Tests may still destroy eagerly; the fallback
 * hook only closes handles that survived a thrown assertion or early return.
 */
export async function openRender(
  ...args: Parameters<typeof renderWithOpenTui>
): Promise<RenderHandle> {
  const rendered = await renderWithOpenTui(...args);
  onTestFinished(() => {
    if (!rendered.renderer.isDestroyed) rendered.renderer.destroy();
  });
  return rendered;
}

/** Waits until every retained syntax owner has reached two visually idle frames. */
export async function settleSyntaxSurfaces(rendered: RenderHandle): Promise<void> {
  let idleFrames = 0;
  for (let attempt = 0; attempt < 650; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 8));
    await rendered.renderOnce();
    const surfaces: Renderable[] = [];
    const codeSurfaces: CodeRenderable[] = [];
    const historyOwners: Renderable[] = [];
    const visit = (node: Renderable): void => {
      if (
        node instanceof CodeRenderable ||
        node instanceof DiffRenderable ||
        node instanceof MarkdownRenderable
      )
        surfaces.push(node);
      if (node instanceof CodeRenderable) codeSurfaces.push(node);
      if (
        node.id.startsWith("history:publication:") ||
        node.id.startsWith("history:fixture:") ||
        node.id === "history:fixture-publication"
      )
        historyOwners.push(node);
      for (const child of node.getChildren()) visit(child);
    };
    visit(rendered.renderer.root);
    if (surfaces.length === 0 && historyOwners.length === 0) return;
    const historyReady =
      historyOwners.length === 0 ||
      historyOwners.every((owner) => owner.opacity === 1 && owner.width > 0 && owner.height > 0);
    const syntaxReady =
      surfaces.every((surface) => surface.opacity === 1) &&
      codeSurfaces.every((surface) => !surface.isHighlighting);
    const visuallyIdle = rendered.getNativeStats().cellsUpdated === 0;
    idleFrames = syntaxReady && historyReady && visuallyIdle ? idleFrames + 1 : 0;
    if (idleFrames >= 2) return;
  }
  const pending: Array<{
    id: string;
    opacity: number;
    type: string;
    width: number;
    height: number;
    destroyed: boolean;
    highlighting?: boolean;
  }> = [];
  const visit = (node: Renderable): void => {
    if (
      node instanceof CodeRenderable ||
      node instanceof DiffRenderable ||
      node instanceof MarkdownRenderable ||
      node.id.startsWith("history:publication:") ||
      node.id.startsWith("history:fixture:") ||
      node.id === "history:fixture-publication"
    )
      pending.push({
        id: node.id,
        opacity: node.opacity,
        type: node.constructor.name,
        width: node.width,
        height: node.height,
        destroyed: node.isDestroyed,
        ...(node instanceof CodeRenderable ? { highlighting: node.isHighlighting } : {}),
      });
    for (const child of node.getChildren()) visit(child);
  };
  visit(rendered.renderer.root);
  throw new Error(
    `syntax surfaces did not reach a stable visible frame: ${JSON.stringify(pending)}`,
  );
}
