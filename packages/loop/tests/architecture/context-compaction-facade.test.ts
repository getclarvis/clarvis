import { describe, expect, it } from "../bun-test.ts";
import { readFileSync } from "node:fs";
import * as facade from "../../src/runtime/context/context-compaction.ts";
import type { LiveContext } from "../../src/runtime/context/compaction-contracts.ts";
import {
  deriveMaxResultChars,
  DISABLED_COMPACTION,
} from "../../src/runtime/context/compaction-policy.ts";
import { createLiveContext } from "../../src/runtime/context/live-context.ts";

describe("context-compaction facade", () => {
  it("preserves the identity of its runtime exports", () => {
    expect(facade.createLiveContext).toBe(createLiveContext);
    expect(facade.deriveMaxResultChars).toBe(deriveMaxResultChars);
    expect(facade.DISABLED_COMPACTION).toBe(DISABLED_COMPACTION);
    expect("createLiveEntryStore" in facade).toBe(false);
    expect("createCompactionSelector" in facade).toBe(false);
    expect("rebuildDroppingTools" in facade).toBe(false);
  });

  it("keeps the LiveContext type reachable through the facade", () => {
    const context: LiveContext = facade.createLiveContext([], DISABLED_COMPACTION, {
      agent: "lead",
    });
    expect(context.messages).toEqual([]);
  });

  it("adds no package entrypoint for implementation modules", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, unknown> };
    expect(
      Object.keys(manifest.exports ?? {}).filter((path) =>
        /compaction|live-context|live-entry/.test(path),
      ),
    ).toEqual([]);
  });
});
