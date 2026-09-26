import { describe, expect, it } from "bun:test";
import {
  environmentFixture,
  sequenceRandom,
  withPlatform,
  withProcessEnv,
} from "../helpers/process-fixtures.ts";

describe("process test fixtures", () => {
  it("copies and freezes environment values while preserving absent and empty states", () => {
    const source: Record<string, string | undefined> = {
      ABSENT: undefined,
      EMPTY: "",
      VALUE: "present",
    };
    const fixture = environmentFixture(source);
    source.VALUE = "changed";

    expect(Object.isFrozen(fixture)).toBe(true);
    expect(fixture.ABSENT).toBeUndefined();
    expect(Object.hasOwn(fixture, "ABSENT")).toBe(true);
    expect(fixture.EMPTY).toBe("");
    expect(fixture.VALUE).toBe("present");
  });

  it("mocks process.env only for the awaited callback and restores it", async () => {
    const original = process.env;
    await withProcessEnv({ CLARVIS_FIXTURE_VALUE: "injected" }, async () => {
      expect(process.env.CLARVIS_FIXTURE_VALUE).toBe("injected");
      await Promise.resolve();
    });
    expect(process.env).toBe(original);
  });

  it("rejects nesting the same environment key", async () => {
    await expect(
      withProcessEnv({ CLARVIS_FIXTURE_VALUE: "outer" }, () =>
        withProcessEnv({ CLARVIS_FIXTURE_VALUE: "inner" }, () => undefined),
      ),
    ).rejects.toThrow("nested process environment fixture");
  });

  it("mocks process.platform only for the awaited callback and restores it", async () => {
    const original = process.platform;
    await withPlatform("darwin", async () => {
      expect(process.platform).toBe("darwin");
      await Promise.resolve();
    });
    expect(process.platform).toBe(original);
  });

  it("consumes random values in order and diagnoses exhaustion", () => {
    const random = sequenceRandom([0.1, 0.9]);
    expect(random()).toBe(0.1);
    expect(random()).toBe(0.9);
    expect(random).toThrow("deterministic random sequence exhausted");
  });
});
