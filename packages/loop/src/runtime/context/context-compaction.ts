/**
 * Compatibility facade for the live-context and compaction policy surface.
 * Implementations live in focused internal modules beside this file.
 */
export * from "./compaction-contracts.ts";
export * from "./compaction-policy.ts";
export { createLiveContext } from "./live-context.ts";
