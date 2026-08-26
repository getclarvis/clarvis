import { TreeSitterClient, getTreeSitterClient } from "@opentui/core";

/**
 * Keep OpenTUI's tree-sitter machinery from ever spawning a worker, for the
 * whole suite.
 *
 * @remarks Every renderable carrying a `filetype` — code blocks, diffs, and the
 * markdown view that embeds them — highlights through the process-wide
 * `getTreeSitterClient()`, whose constructor spawns a `parser.worker.js` Worker
 * (`autoStartWorker ?? true`) and JIT-compiles WASM grammars into it.
 *
 * The previous version of this preload let that worker spawn and then awaited
 * `destroy()` — one spawn *and terminate* cycle at every suite boot — and
 * stubbed `initialize`/`highlightOnce`/`preloadParser` on the singleton. That
 * contained one instance but not the class: `handleReset()` and a bare
 * `initialize()` both restart the worker, so the churn continued through the
 * run.
 *
 * That churn matters because the CI crash this file exists to avoid is an
 * upstream Bun heap corruption whose tracking issue (oven-sh/bun#15964, "Worker
 * & worker_threads stability") tells users not to terminate workers. **This
 * preload cannot fix that bug** — the fault lands in Bun's transpiler thread
 * pool or its main-thread event loop, never in tree-sitter itself. What it can
 * do is remove the worker-teardown trigger entirely. (The avx512 story the
 * previous version of this comment told was wrong: the same crash was reported
 * upstream from a machine without it.)
 *
 * Stubbing `startWorker` on the **prototype**, before anything constructs a
 * client, closes every spawn path at once: the constructor, `initialize()`'s
 * respawn when `this.worker` is unset, and `handleReset()`'s restart — for every
 * instance, including one built outside the singleton, which an
 * `Object.assign(client, …)` can never reach.
 *
 * The cast is needed because `startWorker` is `private` in OpenTUI's `.d.ts`.
 *
 * `destroy()` is no longer called, and dropping it is what makes the instance
 * stubs below reachable at all. `destroy()` fires the client's `onDestroy`
 * callbacks, and the singleton registers one that calls
 * `destroySingleton("tree-sitter-client")` — so the old preload unregistered the
 * very client it then decorated, and every later `getTreeSitterClient()` built a
 * fresh, unstubbed one. That is why the previous version did not hold: measured
 * across this suite it spawned and terminated **82** workers, the churn pattern
 * oven-sh/bun#15964 warns about, rather than the single boot cycle its comment
 * described. With the spawn path closed and the singleton left registered, the
 * count is zero.
 *
 * The three instance stubs below are what preserve the observable contract.
 * Without a worker, `initialize()` would reach `sendWorkerMessage` and throw
 * "TreeSitter worker is not available", and `preloadParser` has no
 * initialization guard at all, so it would reject rather than resolve. Stubbed,
 * highlight is simply unavailable and `CodeRenderable` falls back to plain
 * text — which costs these suites no assertion, because they read
 * `captureCharFrame()`, where highlighting only ever changed the colour.
 *
 * Passing `treeSitterClient` as a JSX prop would not have worked either: the
 * Solid reconciler's `createElement` constructs a renderable with `{ id }` alone
 * and applies every other prop afterwards, so `CodeRenderable`'s
 * `options.treeSitterClient ?? getTreeSitterClient()` has already resolved a
 * client before the prop is ever assigned.
 *
 * `destroyTreeSitterClient()` is deliberately *not* used: it drops the instance
 * from the singleton registry, and the next `getTreeSitterClient()` would hand
 * out a live replacement. Keeping this instance registered is the point.
 *
 * `tests/integration/tree-sitter-preload.test.ts` pins the no-worker invariant.
 */
(TreeSitterClient.prototype as unknown as { startWorker: () => void }).startWorker = () => {};

const client = getTreeSitterClient();

Object.assign(client, {
  initialize: () => Promise.resolve(),
  highlightOnce: () => Promise.resolve({ error: "tree-sitter is disabled for tests" }),
  preloadParser: () => Promise.resolve(false),
});
