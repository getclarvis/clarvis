import { expect, test } from "bun:test";
import { TreeSitterClient, getTreeSitterClient } from "@opentui/core";

/**
 * Read OpenTUI's private `worker` field off a client.
 *
 * @remarks Reaching past `private` is deliberate here, and it is the only
 * assertion that works. Swapping `globalThis.Worker` for a counting stub — the
 * obvious approach — cannot detect the spawn: the bundled client does not
 * resolve `Worker` from the global scope at call time, so the swap counts zero
 * whether or not a worker was created, and a test built on it passes even with
 * the preload's stub removed. The field is the observable that actually
 * distinguishes the two states.
 */
const workerOf = (client: TreeSitterClient): unknown =>
  (client as unknown as { worker: unknown }).worker;

test("constructing a TreeSitterClient spawns no worker under the suite preload", () => {
  const client = new TreeSitterClient({ dataPath: "/tmp/tree-sitter-preload-probe" });

  expect(workerOf(client)).toBeUndefined();
});

test("the tree-sitter singleton holds no worker", () => {
  expect(workerOf(getTreeSitterClient())).toBeUndefined();
});

/**
 * Highlighting must be unavailable, but the *message* is not part of the
 * contract. OpenTUI's renderer teardown calls `destroyTreeSitterClient()`, which
 * unregisters the singleton, so a client built later in the suite carries no
 * instance stubs and reports its own initialization error instead of the
 * preload's sentinel. Either way `CodeRenderable` falls back to plain text,
 * which is the property these suites depend on; asserting the exact string made
 * this pass alone and fail in the full run.
 */
test("highlighting is unavailable, so renderers fall back to plain text", async () => {
  const result = await getTreeSitterClient().highlightOnce("const x = 1;", "typescript");

  expect(result.error).toBeString();
  expect(result.highlights).toBeUndefined();
});
