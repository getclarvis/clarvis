import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { monitorDir, sidecarPath } from "../../src/lib/monitor.ts";
import { createMonitorStop } from "../../src/tools/monitor.ts";
import type { ServerConfig } from "../../src/config.ts";

const mockedKillTree = mock(() => true);
const mockedWait = mock(async (_ms: number) => {});
import { makeWorkspace, cleanup, makeConfig } from "../helpers/fixtures.ts";

describe("monitor_stop SIGKILL escalation", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
    mockedKillTree.mockClear();
    mockedWait.mockClear();
  });
  afterEach(() => cleanup(root));

  it("escalates SIGTERM then SIGKILL when the process outlives the grace", async () => {
    mkdirSync(monitorDir(root), { recursive: true });
    const meta = {
      id: "mon_live",
      command: "x",
      cwd: root,
      pid: process.pid,
      startedAt: 1,
      readyWhen: null,
    };
    writeFileSync(sidecarPath(root, "mon_live"), JSON.stringify(meta));

    const tool = createMonitorStop({
      isAlive: () => true,
      killTree: mockedKillTree,
      wait: mockedWait,
    });
    const output = await tool.handler({ id: "mon_live" }, config);
    expect(typeof output).toBe("string");
    const result = JSON.parse(output as string) as {
      stopped: boolean;
    };
    expect(result.stopped).toBe(true);
    expect(existsSync(sidecarPath(root, "mon_live"))).toBe(false);
    expect(mockedKillTree).toHaveBeenNthCalledWith(1, process.pid, "SIGTERM", {
      logger: config.logger,
    });
    expect(mockedWait).toHaveBeenCalledTimes(1);
    expect(mockedKillTree).toHaveBeenNthCalledWith(2, process.pid, "SIGKILL", {
      logger: config.logger,
    });
  });
});
