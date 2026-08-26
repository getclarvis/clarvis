/**
 * The Bun spawn adapter, driven through a real child.
 *
 * The unit suite reaches every branch of {@link runHookCommand} through a
 * scripted double, which is what makes it fast — but a double replaces the very
 * adapter these cases are about. `bunSpawn`'s own `kill` and stream `destroy`
 * only run against a real `Bun.spawn` handle, and only on paths the ordinary
 * happy course never takes: a process-group kill that fails, and an exit whose
 * pipes a grandchild is still holding open.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHookCommand, type SubprocessRequest } from "@clarvis/hooks";

const posixShell = process.platform !== "win32";

let workspace = "";

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "clarvis-hooks-bunspawn-"));
});

afterAll(async () => {
  if (workspace !== "") await rm(workspace, { recursive: true, force: true });
});

function request(over: Partial<SubprocessRequest> & { command: string }): SubprocessRequest {
  return {
    cwd: workspace,
    env: { PATH: process.env.PATH ?? "" },
    stdin: "",
    timeoutMs: 1_000,
    ...over,
  };
}

describe.skipIf(!posixShell)("the Bun spawn adapter", () => {
  test("falls back to the child's own kill when the process group cannot be reaped", async () => {
    // `killTree` is the first attempt and normally succeeds, which leaves the
    // per-child fallback unexercised. Reporting failure forces the adapter's
    // own `kill` to be the thing that stops a hook that overran.
    const groupKills: NodeJS.Signals[] = [];
    const result = await runHookCommand(request({ command: "sleep 30", timeoutMs: 120 }), {
      killTree: (_pid, signal) => {
        groupKills.push(signal);
        return false;
      },
    });

    expect(result.timedOut).toBe(true);
    expect(groupKills.length).toBeGreaterThan(0);
    expect(result.spawnError).toBeUndefined();
  });

  test("destroys the pipes when a grandchild holds them open past the drain bound", async () => {
    // The shell exits immediately while a background grandchild keeps stdout
    // open, so the exit lands but the stream never ends on its own. The drain
    // bound is what closes it, and closing it is what `destroy` does.
    const result = await runHookCommand(
      request({ command: "sleep 5 & exit 0", timeoutMs: 4_000 }),
      {},
    );

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("");
  });
});
