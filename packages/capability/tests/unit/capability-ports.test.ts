import { describe, expect, it } from "../helpers/bun-test.ts";

import {
  createCapabilityRequestView,
  createCapabilityServices,
  portKey,
} from "../../src/services.ts";
import type { RunRequest } from "../../src/api.ts";
import { TOOL_EFFECT_PORT } from "../../src/tool-effect.ts";
import { TASK_TRACKING_PORT } from "../../src/task-tracking-port.ts";
import { partialStructOf } from "../../src/agent-result.ts";
import { projected, type CapabilityEvent } from "../../src/contract.ts";

describe("createCapabilityServices", () => {
  it("returns undefined for a key nobody provided, so a consumer reads that as the feature being off", () => {
    const services = createCapabilityServices();
    const key = portKey<{ ping(): string }>("nonexistent.port");
    expect(services.get(key)).toBeUndefined();
  });

  it("round-trips a provided value back out under the same key", () => {
    const services = createCapabilityServices();
    const key = portKey<{ ping(): string }>("test.port");
    const value = { ping: () => "pong" };
    services.provide(key, value);
    const got = services.get(key);
    expect(got).toBe(value);
    expect(got?.ping()).toBe("pong");
  });

  it("throws rather than silently overwriting a key that is already taken", () => {
    const services = createCapabilityServices();
    const key = portKey<number>("dup.port");
    services.provide(key, 1);
    expect(() => services.provide(key, 2)).toThrow(
      "capability port 'dup.port' is already provided",
    );
    // the rejected overwrite must not have taken effect
    expect(services.get(key)).toBe(1);
  });

  it("keeps distinct keys independent, even when minted from the same registry", () => {
    const services = createCapabilityServices();
    const a = portKey<number>("port.a");
    const b = portKey<string>("port.b");
    services.provide(a, 1);
    services.provide(b, "two");
    expect(services.get(a)).toBe(1);
    expect(services.get(b)).toBe("two");
  });
});

describe("createCapabilityRequestView", () => {
  it("keeps the validated request and reads open capability params from that same object", () => {
    const request = {
      messages: [],
      servers: [],
      profiles: [],
      entry: "solo",
      providers: [],
      budget: { on_exceed: "stop" },
      widgets: { mode: "review" },
    } satisfies RunRequest & { widgets: { mode: string } };
    const view = createCapabilityRequestView(request);
    expect(view.request).toBe(request);
    expect(view.requestParam("widgets")).toEqual({ mode: "review" });
    expect(view.requestParam("absent")).toBeUndefined();
  });
});

describe("TOOL_EFFECT_PORT", () => {
  it("is namespaced under tools.effect", () => {
    expect(TOOL_EFFECT_PORT.id).toBe("tools.effect");
  });
});

describe("TASK_TRACKING_PORT", () => {
  it("owns one neutral canonical key for task trackers", () => {
    expect(TASK_TRACKING_PORT.id).toBe("delegation.task-tracking");
  });
});

describe("partialStructOf", () => {
  it("wraps a remembered submit attempt in partialStructured", () => {
    const attempt = { value: { foo: "bar" } };
    expect(partialStructOf(attempt)).toEqual({ partialStructured: attempt });
  });

  it("returns an empty, spread-ready object when nothing was ever submitted", () => {
    const result = partialStructOf(undefined);
    expect(result).toEqual({});
    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe("projected", () => {
  it("fills wire.type from kind and carries detail through when the event has one", () => {
    const event: CapabilityEvent = {
      capability: "memory",
      kind: "ingest_started",
      detail: { count: 3 },
    };
    const result = projected(event);
    expect(result).toEqual({
      ...event,
      wire: { type: "ingest_started", detail: { count: 3 } },
    });
  });

  it("omits wire.detail entirely — not as undefined — when the event carries no detail", () => {
    const event: CapabilityEvent = { capability: "memory", kind: "ingest_finished" };
    const result = projected(event);
    expect(result.wire).toEqual({ type: "ingest_finished" });
    if (result.wire === undefined) throw new Error("projected event has no wire payload");
    expect(Object.hasOwn(result.wire, "detail")).toBe(false);
  });
});
