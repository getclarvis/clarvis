import type { ImagePart, Message } from "@clarvis/capability";
import type { ContextSnapshotEntry, RunContinuation } from "@clarvis/capability";
import { buildSystemSections, collectTurnImages } from "./subagents/build-subagent-input.ts";
import type { LiveSeedEntry } from "./context/context-compaction.ts";
import type { RunCapability } from "@clarvis/capability";
import { systemSectionsFor } from "@clarvis/capability";
import type { RunShape } from "./run-shape.ts";

/**
 * The inputs {@link buildEntrySeed} needs to compose the entry agent's opening
 * context: the workspace root, an optional resume `continuation`, and the run's
 * capabilities, pinned seed blocks and the markers that identify them.
 */
export interface EntrySeedDeps {
  workspaceRoot: string;
  continuation?: RunContinuation;
  /** The run's active capabilities; their systemSection(id) feeds the head. */
  runCapabilities?: readonly RunCapability[];
  /** Pinned capability blocks, one entry each. */
  seedBlocks?: readonly string[];
  /** Open tags identifying capability seed entries in continuation context. */
  seedMarkers?: readonly string[];
}

/**
 * The composed opening context: the ordered `entryMessages` (system head, pinned
 * seed blocks, continuation history, then this turn's messages), the `turnImages`
 * collected from this turn, and whether this agent `entryStripsImages`.
 */
export interface EntrySeed {
  entryMessages: LiveSeedEntry[];
  turnImages: ImagePart[];
  entryStripsImages: boolean;
}

/**
 * Which capability a seed block belongs to, identified by the open tag it starts
 * with.
 *
 * @param content - a message's content; a non-string is never a seed block.
 * @param markers - the open tags of every registered capability.
 * @returns the matching marker, or `undefined` when this is not a seed block.
 * @remarks A capability that emits a `seedBlock` without declaring a
 *   `seedMarker` is unrecognisable here, so its block cannot be matched against
 *   the copy a continuation restored and a fresh copy is added every turn. That
 *   was true before this function existed and is the reason `seedMarker` is
 *   collected from every *registered* capability rather than the active ones.
 */
function seedMarkerOf(content: unknown, markers: readonly string[]): string | undefined {
  if (typeof content !== "string") return undefined;
  return markers.find((tag) => content.startsWith(tag));
}

/** The seed marker of a restored entry, or `undefined` when it is not one. */
function entrySeedMarker(
  entry: ContextSnapshotEntry,
  markers: readonly string[],
): string | undefined {
  return entry.message.role === "user" ? seedMarkerOf(entry.message.content, markers) : undefined;
}

/**
 * Whether a restored entry is one the engine rewrites or repositions on the
 * first iteration of the new run.
 *
 * @remarks Mirrors `isVolatile` in `context-compaction.ts`: the canonical block
 *   and the runtime notes are spliced out and re-appended rather than surviving
 *   in place.
 */
function isRestoredVolatile(entry: ContextSnapshotEntry): boolean {
  return entry.canonical || entry.note_kind !== undefined;
}

/** Replace image parts in a continuation user message with a text placeholder, so
 * a non-vision entry agent carries no stale image bytes from earlier turns; a
 * text-only or image-free entry is returned unchanged. */
function collapseHistoricalImages(entry: ContextSnapshotEntry): ContextSnapshotEntry {
  const m = entry.message;
  if (m.role !== "user" || typeof m.content === "string") return entry;
  if (!m.content.some((p) => p.type === "image")) return entry;
  const content = m.content.map((p) =>
    p.type === "image" ? { type: "text" as const, text: "[image from an earlier turn]" } : p,
  );
  return { ...entry, message: { ...m, content } };
}

/**
 * Compose the entry agent's opening messages: a system head (base prompt plus
 * active capability sections), the filtered continuation history, any capability
 * seed block the continuation did not already carry, and this turn's messages.
 *
 * @returns the {@link EntrySeed} — messages, this turn's images, and whether the
 *   agent strips images.
 * @remarks A non-vision entry agent (no `vision` capability) has both its
 *   continuation images collapsed to placeholders and this turn's images
 *   available separately.
 *
 *   **Two rules here exist to keep a continued run's prompt prefix intact**, and
 *   both were learned from a measured session that paid for breaking them.
 *
 *   *Restored volatile entries are dropped.* The canonical block and the runtime
 *   notes are spliced out and re-appended by their owners on the first iteration
 *   anyway, so carrying them forward only buries them mid-array — and the next
 *   splice then shifts every entry behind them. It is also the right content
 *   decision: a `convergence_warning` or `empty_response` note describes a moment
 *   in the *previous* turn and has no business instructing this one. The shape's
 *   canonical-state pin is republished by its owning capability's
 *   `beforeIteration` before the first model call, so nothing is lost.
 *
 *   *A seed block the continuation already carries is kept, not regenerated.*
 *   The block was persisted as an ordinary entry, and it sits ahead of the whole
 *   restored transcript — so replacing it with a freshly rendered copy
 *   invalidates the cache for everything behind it. A capability whose block is
 *   rendered from a document its own post-run pass is *expected* to rewrite
 *   between turns regenerates a different block every time, and one measured
 *   boundary paid **115,432 tokens** for exactly that. Keeping it makes the
 *   block stable for the life of a session; the rewritten content therefore
 *   reaches the *next* session, not the current one.
 *
 *   A block whose capability is no longer active is still dropped (its marker is
 *   absent from this run's blocks), and a newly active capability's block is
 *   appended *after* the restored history rather than at the head, so it costs
 *   nothing ahead of it. On a fresh run `continuationSeed` is empty and the
 *   result is the historical one: system head, pinned blocks, this turn.
 */
export function buildEntrySeed(a: {
  messages: readonly Message[];
  deps: EntrySeedDeps;
  shape: RunShape;
}): EntrySeed {
  const { messages, deps, shape } = a;
  const { entryProfile, entryResolved } = shape;

  const turnImages = collectTurnImages(messages);
  const entryStripsImages = !(entryResolved.capabilities?.has("vision") ?? true);

  const capabilitySections = systemSectionsFor(deps.runCapabilities, {
    agent: shape.isLead ? "lead" : "subagent",
    entry: true,
    grants: entryProfile.grants ?? [],
  });
  const systemHead: Message = {
    role: "system",
    content: buildSystemSections({
      workspaceRoot: deps.workspaceRoot,
      ...(entryResolved.basePrompt !== undefined ? { basePrompt: entryResolved.basePrompt } : {}),
      ...(capabilitySections.length > 0 ? { capabilitySections } : {}),
    }).join("\n\n"),
  };
  const markers = deps.seedMarkers ?? [];
  const freshBlocks = deps.seedBlocks ?? [];
  const liveMarkers = new Set(
    freshBlocks.map((b) => seedMarkerOf(b, markers)).filter((m): m is string => m !== undefined),
  );

  const continuationSeed = (deps.continuation?.context ?? []).filter((entry) => {
    if (isRestoredVolatile(entry)) return false;
    const marker = entrySeedMarker(entry, markers);
    return marker === undefined || liveMarkers.has(marker);
  });

  const carriedMarkers = new Set(
    continuationSeed
      .map((entry) => entrySeedMarker(entry, markers))
      .filter((m): m is string => m !== undefined),
  );
  const pinnedEntries: LiveSeedEntry[] = freshBlocks
    .filter((block) => {
      const marker = seedMarkerOf(block, markers);
      return marker === undefined || !carriedMarkers.has(marker);
    })
    .map((content) => ({ role: "user", content }));

  const entryMessages: LiveSeedEntry[] = [
    systemHead,
    ...(entryStripsImages ? continuationSeed.map(collapseHistoricalImages) : continuationSeed),
    ...pinnedEntries,
    ...messages,
  ];

  return {
    entryMessages,
    turnImages,
    entryStripsImages,
  };
}
