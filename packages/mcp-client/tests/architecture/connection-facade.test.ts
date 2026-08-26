import { describe, expect, it } from "bun:test";
import * as facade from "../../src/index.ts";
import {
  DEFAULT_HEALTH_PING_INTERVAL_MS,
  DEFAULT_TIMEOUT_STREAK_THRESHOLD,
  MCPConnectionFailedError,
  UNAVAILABLE_REPROBE_COOLDOWN_MS,
  openConnection,
} from "../../src/connection.ts";

describe("connection public facade", () => {
  it("keeps the public connection exports identical without exposing internals", () => {
    expect(facade.openConnection).toBe(openConnection);
    expect(facade.MCPConnectionFailedError).toBe(MCPConnectionFailedError);
    expect(facade.UNAVAILABLE_REPROBE_COOLDOWN_MS).toBe(UNAVAILABLE_REPROBE_COOLDOWN_MS);
    expect(facade.DEFAULT_TIMEOUT_STREAK_THRESHOLD).toBe(DEFAULT_TIMEOUT_STREAK_THRESHOLD);
    expect(facade.DEFAULT_HEALTH_PING_INTERVAL_MS).toBe(DEFAULT_HEALTH_PING_INTERVAL_MS);
    expect("createResilientSession" in facade).toBe(false);
    expect("resourceContentsToBlocks" in facade).toBe(false);
    expect("interpretCallResult" in facade).toBe(false);
  });
});
