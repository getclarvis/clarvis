import { describe, expect, it } from "../bun-test.ts";

import { loadEnv } from "@clarvis/capability";
import { createLiveContext } from "../../src/runtime/context/context-compaction.ts";
import { buildEntrySeed, type EntrySeed } from "../../src/runtime/entry-seed.ts";
import { deriveRunShape } from "../../src/runtime/run-shape.ts";
import { resolveSubagentProfiles } from "../../src/runtime/subagents/subagent-profiles.ts";
import type { ContextSnapshotEntry } from "@clarvis/capability";
import { validateBody } from "../../src/validation/request-schema.ts";

const BODY = {
  messages: [{ role: "user", content: "do the thing" }],
  servers: [],
  profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
  entry: "solo",
  providers: [{ name: "anthropic", kind: "anthropic" }],
  budget: { on_exceed: "stop", total_token_limit: 1000 },
};

/**
 * A capability's pinned seed block, spelled locally.
 *
 * The engine's rule is capability-agnostic — it strips a block whose open tag a
 * *registered* capability declares as its `seedMarker`, whoever that capability
 * is. The tag is spelled here rather than imported so a test of engine behaviour
 * does not depend on any feature package.
 */
const SEED_OPEN_TAG = "<cap-block>";
const SEED = `${SEED_OPEN_TAG}\nObservations…\n</cap-block>`;

function makeFixtures() {
  const env = loadEnv({});
  const { request } = validateBody(BODY, env);
  const registry = resolveSubagentProfiles(request.profiles, request.providers, env);
  const shape = deriveRunShape(request, registry);
  return { env, request, shape };
}

function snapshotEntry(content: string, evictable = false): ContextSnapshotEntry {
  return {
    message: { role: "user", content },
    evictable,
    canonical: false,
    summary: false,
  };
}

/** The composed seed's message texts, in order. */
function texts(seed: EntrySeed): string[] {
  return seed.entryMessages.map((entry) => {
    const message = "message" in entry ? entry.message : entry;
    return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  });
}

describe("buildEntrySeed capability seed block", () => {
  it("injects the seed as its own user entry right after the system head", () => {
    const { request, shape } = makeFixtures();
    const seed = buildEntrySeed({
      messages: request.messages,
      deps: { workspaceRoot: "/ws", seedBlocks: [SEED] },
      shape,
    });
    expect(seed.entryMessages).toHaveLength(3);
    expect(seed.entryMessages[0]).toMatchObject({ role: "system" });
    expect(seed.entryMessages[1]).toEqual({ role: "user", content: SEED });
    const bare = buildEntrySeed({
      messages: request.messages,
      deps: { workspaceRoot: "/ws" },
      shape,
    });
    expect(seed.entryMessages[0]).toEqual(bare.entryMessages[0]);
  });

  it("the injected seed entry is non-evictable in the live context (pinned)", () => {
    const { request, shape } = makeFixtures();
    const seed = buildEntrySeed({
      messages: request.messages,
      deps: { workspaceRoot: "/ws", seedBlocks: [SEED] },
      shape,
    });
    const ctx = createLiveContext(seed.entryMessages, shape.entryResolved.compaction, {
      agent: "lead",
    });
    const seedEntry = ctx
      .snapshot()
      .find((e) => typeof e.message.content === "string" && e.message.content === SEED);
    expect(seedEntry).toBeDefined();
    expect(seedEntry!.evictable).toBe(false);
  });

  /**
   * The block the continuation restored is kept byte-for-byte and the freshly
   * rendered one is discarded. It sits ahead of the whole restored transcript,
   * so swapping it re-charges everything behind it — one measured continuation
   * boundary paid 115,432 tokens for exactly that. The consequence is deliberate:
   * newly indexed `PROFILE.md` content reaches the next session, not this one.
   */
  it("keeps the seed block the continuation carried instead of regenerating it", () => {
    const { request, shape } = makeFixtures();
    const carried = `${SEED_OPEN_TAG}\nwhat the session started with\n</cap-block>`;
    const seed = buildEntrySeed({
      messages: request.messages,
      deps: {
        workspaceRoot: "/ws",
        continuation: {
          context: [snapshotEntry(carried), snapshotEntry("a normal earlier message", true)],
        },
        seedBlocks: [SEED],
        seedMarkers: [SEED_OPEN_TAG],
      },
      shape,
    });
    expect(texts(seed).slice(1)).toEqual([carried, "a normal earlier message", "do the thing"]);
    expect(texts(seed)).not.toContain(SEED);
  });

  it("retains historical blocks when their capability is no longer active", () => {
    const { request, shape } = makeFixtures();
    const seed = buildEntrySeed({
      messages: request.messages,
      deps: {
        workspaceRoot: "/ws",
        continuation: {
          context: [
            snapshotEntry(`${SEED_OPEN_TAG}\nold stale block\n</cap-block>`),
            snapshotEntry("a normal earlier message", true),
          ],
        },
        seedMarkers: [SEED_OPEN_TAG],
      },
      shape,
    });
    expect(texts(seed).some((t) => t.includes("old stale block"))).toBe(true);
    expect(texts(seed)).toContain("a normal earlier message");
  });

  it("appends a newly active capability's block after the restored history", () => {
    const { request, shape } = makeFixtures();
    const seed = buildEntrySeed({
      messages: request.messages,
      deps: {
        workspaceRoot: "/ws",
        continuation: { context: [snapshotEntry("a normal earlier message", true)] },
        seedBlocks: [SEED],
        seedMarkers: [SEED_OPEN_TAG],
      },
      shape,
    });
    expect(texts(seed).slice(1)).toEqual(["a normal earlier message", SEED, "do the thing"]);
  });

  it("restores prior notes and reminders in their persisted order", () => {
    const { request, shape } = makeFixtures();
    const seed = buildEntrySeed({
      messages: request.messages,
      deps: {
        workspaceRoot: "/ws",
        continuation: {
          context: [
            snapshotEntry("a normal earlier message", true),
            { ...snapshotEntry("[runtime: the same tool call returned…]"), note_kind: "warn" },
            { ...snapshotEntry("State file: … expected_revision: 7"), canonical: true },
          ],
        },
        seedMarkers: [SEED_OPEN_TAG],
      },
      shape,
    });
    expect(texts(seed).slice(1)).toEqual([
      "a normal earlier message",
      "[runtime: the same tool call returned…]",
      "State file: … expected_revision: 7",
      "do the thing",
    ]);
  });

  /**
   * The property all of the above serve: turn N+1's prompt must open with turn
   * N's transcript byte for byte, so the provider serves it from cache.
   */
  it("reproduces the restored transcript as an unbroken prefix", () => {
    const { request, shape } = makeFixtures();
    const carried = `${SEED_OPEN_TAG}\nwhat the session started with\n</cap-block>`;
    const history = [
      snapshotEntry(carried),
      ...Array.from({ length: 30 }, (_, i) => snapshotEntry(`earlier ${i}`, true)),
    ];
    const seed = buildEntrySeed({
      messages: request.messages,
      deps: {
        workspaceRoot: "/ws",
        continuation: {
          context: [...history, { ...snapshotEntry("[runtime: n]"), note_kind: "budget" }],
        },
        seedBlocks: [SEED],
        seedMarkers: [SEED_OPEN_TAG],
      },
      shape,
    });
    const restored = history.map((e) => e.message.content as string);
    expect(texts(seed).slice(1, 1 + restored.length)).toEqual(restored);
  });
});
