import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { isAlive, ownedTreeRunning, stopOwnedProcess } from "../../src/lib/process-owner.ts";
import { cleanup, makeConfig, makeWorkspace } from "../helpers/fixtures.ts";

it.skipIf(process.platform === "win32")(
  "escalates from TERM to KILL for an owned process that ignores TERM",
  async () => {
    const root = makeWorkspace();
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); process.stdout.write('READY\\n'); setInterval(() => {}, 1000)",
      ],
      { cwd: root, detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      const pid = child.pid;
      expect(pid).toBeDefined();
      const ready = once(child.stdout!, "data");
      const exited = once(child, "exit");
      await ready;
      const owner = { pid: pid!, child };
      expect(isAlive(pid!)).toBe(true);
      expect(ownedTreeRunning(owner)).toBe(true);
      const config = makeConfig(root);
      expect(await stopOwnedProcess(owner, config.logger, Date.now() + 1_200)).toBe(true);
      await exited;
      expect(child.signalCode).toBe("SIGKILL");
      expect(isAlive(pid!)).toBe(false);
      expect(ownedTreeRunning(owner)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      cleanup(root);
    }
  },
);
