import { describe, expect, it, vi } from "bun:test";
import { NOOP_LOGGER } from "@clarvis/capability";
import {
  causeOf,
  closeQuietly,
  DEFAULT_DIAGNOSTICS,
  defaultWarnSink,
  warn,
} from "../../src/lib/log.ts";
import { recordingLogger } from "../helpers/logging.ts";

describe("warn", () => {
  it("writes to stderr by default", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      warn("a message\n");
      expect(spy).toHaveBeenCalledWith("a message\n");
    } finally {
      spy.mockRestore();
    }
  });

  it("routes one call to a custom instance-local sink", () => {
    const seen: string[] = [];
    warn("captured", (m) => seen.push(m));
    expect(seen).toEqual(["captured"]);
  });
});

describe("causeOf", () => {
  it("prefers an Error's message and stringifies anything else", () => {
    expect(causeOf(new Error("boom"))).toBe("boom");
    expect(causeOf("plain")).toBe("plain");
    expect(causeOf(7)).toBe("7");
  });
});

describe("closeQuietly", () => {
  it("returns silently when the handle closes", () => {
    const recorder = recordingLogger();
    let closed = false;
    closeQuietly(
      () => {
        closed = true;
      },
      recorder.logger,
      { path: "/tmp/x" },
    );
    expect(closed).toBe(true);
    expect(recorder.records).toEqual([]);
  });

  it("reports a handle that refuses to close rather than swallowing it", () => {
    const recorder = recordingLogger();
    closeQuietly(
      () => {
        throw new Error("EBADF");
      },
      recorder.logger,
      { path: "/tmp/x" },
    );
    const [record] = recorder.events("skill.handle_close_failed");
    expect(record?.level).toBe("debug");
    expect(record?.fields).toMatchObject({ path: "/tmp/x", cause: "EBADF" });
  });
});

describe("DEFAULT_DIAGNOSTICS", () => {
  it("pairs the stderr sink with a logger that emits nothing", () => {
    expect(DEFAULT_DIAGNOSTICS.warningSink).toBe(defaultWarnSink);
    expect(DEFAULT_DIAGNOSTICS.logger).toBe(NOOP_LOGGER);
  });
});
