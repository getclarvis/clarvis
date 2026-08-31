import { onTestFinished } from "bun:test";
import { createTestRenderer as createOpenTuiTestRenderer } from "@opentui/core/testing";

type CoreRenderHandle = Awaited<ReturnType<typeof createOpenTuiTestRenderer>>;

/** Core-renderer counterpart of tracked Solid {@link openRender}. */
export async function openCoreRenderer(
  ...args: Parameters<typeof createOpenTuiTestRenderer>
): Promise<CoreRenderHandle> {
  const rendered = await createOpenTuiTestRenderer(...args);
  onTestFinished(() => {
    if (!rendered.renderer.isDestroyed) rendered.renderer.destroy();
  });
  return rendered;
}
