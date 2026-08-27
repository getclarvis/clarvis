import { describe, expect, test } from "bun:test";
import { AGENTS_DEFAULTS, AGENTS_MAX_LIVE_CHILDREN } from "@clarvis/supervision";
import {
  managerLiveChildrenFloor,
  WORKFLOWS_DEFAULTS,
  WORKFLOWS_MAX_CONCURRENCY,
  WORKFLOWS_SETTINGS_FIELDS,
} from "../../src/settings.ts";

const block = WORKFLOWS_SETTINGS_FIELDS.workflows;

describe("the workflows settings block", () => {
  test("accepts a concurrency up to the published ceiling and refuses past it", () => {
    expect(block.parse({ max_concurrency: WORKFLOWS_MAX_CONCURRENCY })).toMatchObject({
      max_concurrency: WORKFLOWS_MAX_CONCURRENCY,
    });
    expect(() => block.parse({ max_concurrency: WORKFLOWS_MAX_CONCURRENCY + 1 })).toThrow();
    expect(() => block.parse({ max_concurrency: 0 })).toThrow();
  });

  test("an omitted block still carries the product defaults", () => {
    expect(block.parse({})).toEqual({
      max_concurrency: WORKFLOWS_DEFAULTS.max_concurrency,
      budget_tokens: WORKFLOWS_DEFAULTS.budget_tokens,
    });
    expect(WORKFLOWS_DEFAULTS.budget_tokens).toBe(640_000_000);
  });
});

describe("the live-children floor a manager's concurrency implies", () => {
  test("the default concurrency needs exactly the supervision default", () => {
    expect(managerLiveChildrenFloor(WORKFLOWS_DEFAULTS.max_concurrency)).toBe(
      AGENTS_DEFAULTS.max_live_children,
    );
  });

  test("it leaves room above the leaders for the baton and an ad-hoc spawn", () => {
    expect(managerLiveChildrenFloor(10)).toBeGreaterThan(10);
  });

  test("the published ceiling still fits under the registry's own", () => {
    expect(managerLiveChildrenFloor(WORKFLOWS_MAX_CONCURRENCY)).toBeLessThanOrEqual(
      AGENTS_MAX_LIVE_CHILDREN,
    );
  });

  test("a nonsensical concurrency is floored rather than propagated", () => {
    expect(managerLiveChildrenFloor(0)).toBe(managerLiveChildrenFloor(1));
    expect(managerLiveChildrenFloor(Number.NaN)).toBe(managerLiveChildrenFloor(1));
    expect(managerLiveChildrenFloor(10_000)).toBe(AGENTS_MAX_LIVE_CHILDREN);
  });
});
