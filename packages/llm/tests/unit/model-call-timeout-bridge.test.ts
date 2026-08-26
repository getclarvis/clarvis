/**
 * The per-call timeout bridge, driven directly.
 *
 * Admission exercises the happy course of this module as a side effect, which
 * leaves the edges — a second `markTimedOut`, an unregister, a cleanup that
 * throws, and registering after the bridge has already been cleaned — resting
 * on nothing. Each of those is a real ordering a provider call can produce.
 */
import { describe, expect, it } from "../helpers/bun-test.ts";
import {
  bridgeModelCallTimeout,
  modelCallTimeoutBridgeOf,
} from "../../src/model-call-timeout-bridge.ts";
import type { LLMCallParams } from "@clarvis/capability";

function params(): LLMCallParams {
  return { provider: "test", model: "test/model", messages: [], tools: [] };
}

describe("bridgeModelCallTimeout", () => {
  it("carries the bridge on the params it hands back", () => {
    const { params: bridged, bridge } = bridgeModelCallTimeout(params());
    expect(modelCallTimeoutBridgeOf(bridged)).toBe(bridge);
  });

  it("reports no bridge on params that were never wrapped", () => {
    expect(modelCallTimeoutBridgeOf(params())).toBeUndefined();
  });

  it("mints the timeout error once and resolves the promise with it", async () => {
    const { bridge } = bridgeModelCallTimeout(params());

    const first = bridge.markTimedOut(1_500);
    const second = bridge.markTimedOut(9_999);

    expect(second).toBe(first);
    expect(first.message).toContain("1500ms");
    await expect(bridge.timeout).resolves.toBe(first);
  });

  it("runs each registered cleanup once, and forgets an unregistered one", () => {
    const { bridge } = bridgeModelCallTimeout(params());
    const ran: string[] = [];
    bridge.registerCleanup(() => ran.push("kept"));
    const unregister = bridge.registerCleanup(() => ran.push("dropped"));

    unregister();
    bridge.cleanup();
    bridge.cleanup();

    expect(ran).toEqual(["kept"]);
  });

  it("does not let a throwing cleanup replace the provider's result", () => {
    const { bridge } = bridgeModelCallTimeout(params());
    const ran: string[] = [];
    bridge.registerCleanup(() => {
      throw new Error("clearTimeout blew up");
    });
    bridge.registerCleanup(() => ran.push("still ran"));

    expect(() => bridge.cleanup()).not.toThrow();
    expect(ran).toEqual(["still ran"]);
  });

  it("ignores a cleanup registered after the bridge was already cleaned", () => {
    // A late timer can still try to register while the call is unwinding. It
    // must neither run nor be retained, and the unregister it is handed back
    // has to stay safe to call.
    const { bridge } = bridgeModelCallTimeout(params());
    bridge.cleanup();

    let lateRan = false;
    const unregister = bridge.registerCleanup(() => {
      lateRan = true;
    });

    expect(() => unregister()).not.toThrow();
    bridge.cleanup();
    expect(lateRan).toBe(false);
  });
});
