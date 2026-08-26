import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ServerConfig } from "../../src/config.ts";
import type { spawn } from "node:child_process";
import { createMonitorStart } from "../../src/tools/monitor.ts";
import { makeWorkspace, cleanup, makeConfig } from "../helpers/fixtures.ts";

describe("monitor spawn failures", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => {
    cleanup(root);
  });

  it("returns io_error and cleans up the log when spawn throws", async () => {
    const tool = createMonitorStart((() => {
      throw new Error("spawn boom");
    }) as typeof spawn);
    expect(tool.handler({ command: "true" }, config)).rejects.toMatchObject({ code: "io_error" });
    const clarvis = path.join(root, ".clarvis");
    const leftover = existsSync(clarvis)
      ? (await import("node:fs")).readdirSync(clarvis).filter((n) => n.startsWith("monitor-"))
      : [];
    expect(leftover).toEqual([]);
  });

  it("returns io_error when the spawned child has no pid", async () => {
    const tool = createMonitorStart((() => {
      return {
        pid: undefined,
        on() {},
        unref() {},
      };
    }) as unknown as typeof spawn);
    expect(tool.handler({ command: "true" }, config)).rejects.toMatchObject({ code: "io_error" });
  });
});
