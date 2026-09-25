/**
 * Shell resolution and process-tree termination, off the main entrypoint.
 *
 * @remarks
 * `@clarvis/tools`' root export pulls the whole tool registry - ajv and diff - which is the wrong price for
 * a consumer that only needs to know which shell this host speaks and how to
 * kill what it spawned. This subpath carries exactly that, so
 * `@clarvis/hooks` (and anything else running a command outside the tool
 * dispatcher) shares one answer with the `shell` tool rather than growing its
 * own.
 *
 * The two halves belong together: {@link ownProcessGroup} decides what `spawn`'s
 * `detached` option must be on this platform, and {@link killTree} is what that
 * decision exists to enable.
 */
export { resolveShell, shellArgs } from "./shell.ts";
export type { ShellSpec } from "./shell.ts";
export { killTree, ownProcessGroup } from "./lib/process.ts";
export { isAlive } from "./lib/process-owner.ts";
export type { KillDeps } from "./lib/process.ts";
