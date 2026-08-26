import { afterEach, describe, expect, test } from "bun:test";

import { NOOP_PATHS_LOGGER, setPathsLogger } from "@clarvis/paths";
import { announceOnce, pathsLogger } from "../../src/diag.ts";
import { recorder } from "../helpers/recorder.ts";

afterEach(() => {
  setPathsLogger(null);
});

describe("the no-op logger", () => {
  test("discards every level, so a package with no host prints nothing", () => {
    expect(NOOP_PATHS_LOGGER.debug({ event: "x" }, "m")).toBeUndefined();
    expect(NOOP_PATHS_LOGGER.info({ event: "x" }, "m")).toBeUndefined();
    expect(NOOP_PATHS_LOGGER.warn({ event: "x" }, "m")).toBeUndefined();
    expect(NOOP_PATHS_LOGGER.error({ event: "x" }, "m")).toBeUndefined();
  });

  test("is the default sink, because @clarvis/code locates roots before a kernel exists", () => {
    expect(pathsLogger()).toBe(NOOP_PATHS_LOGGER);
  });
});

describe("the process-wide sink", () => {
  test("routes to the installed logger and restores the no-op on null", () => {
    const sink = recorder();
    setPathsLogger(sink.logger);
    expect(pathsLogger()).toBe(sink.logger);
    pathsLogger().debug({ event: "paths.example" }, "hello");
    expect(sink.records).toEqual([
      { level: "debug", fields: { event: "paths.example" }, msg: "hello" },
    ]);
    setPathsLogger(null);
    expect(pathsLogger()).toBe(NOOP_PATHS_LOGGER);
  });
});

describe("announceOnce", () => {
  test("admits one occurrence of a key and suppresses the rest", () => {
    const key = `diag-test-${Math.random()}`;
    expect(announceOnce(key)).toBe(true);
    expect(announceOnce(key)).toBe(false);
    expect(announceOnce(key)).toBe(false);
  });

  test("installing a sink resets the gates, so a host still sees the first occurrence", () => {
    const key = `diag-reset-${Math.random()}`;
    expect(announceOnce(key)).toBe(true);
    setPathsLogger(recorder().logger);
    expect(announceOnce(key)).toBe(true);
  });

  test("clears the whole budget rather than evicting, past 256 distinct keys", () => {
    const first = `diag-budget-${Math.random()}`;
    expect(announceOnce(first)).toBe(true);
    for (let i = 0; i < 300; i += 1) announceOnce(`${first}-${i}`);
    expect(announceOnce(first)).toBe(true);
  });
});
