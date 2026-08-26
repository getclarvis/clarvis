import { afterEach } from "bun:test";
import { createTestRenderer as createOpenTuiTestRenderer } from "@opentui/core/testing";

type CoreRenderHandle = Awaited<ReturnType<typeof createOpenTuiTestRenderer>>;

const openRenders = new Set<CoreRenderHandle>();

/** Core-renderer counterpart of tracked Solid {@link openRender}. */
export async function openCoreRenderer(
  ...args: Parameters<typeof createOpenTuiTestRenderer>
): Promise<CoreRenderHandle> {
  const rendered = await createOpenTuiTestRenderer(...args);
  openRenders.add(rendered);
  return rendered;
}

afterEach(() => {
  for (const rendered of openRenders) {
    if (!rendered.renderer.isDestroyed) rendered.renderer.destroy();
  }
  openRenders.clear();
});
