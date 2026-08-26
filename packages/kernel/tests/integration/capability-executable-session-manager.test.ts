import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CapabilityExecutableRpcError } from "@clarvis/capability";
import { createCapabilityExecutableSessionManager } from "../../src/capability-executables/session-manager.ts";

const FIXTURE = join(import.meta.dir, "..", "helpers", "capability-executable-fixture.ts");
const managers: ReturnType<typeof createCapabilityExecutableSessionManager>[] = [];

function manager(environment: Record<string, string | undefined> = {}) {
  const value = createCapabilityExecutableSessionManager({
    environment: { ...process.env, ...environment },
  });
  managers.push(value);
  return value;
}

function input(workspace: string, over: Record<string, unknown> = {}) {
  return {
    capability: "memory",
    workspace,
    cwd: workspace,
    declaration: {
      command: process.execPath,
      args: [FIXTURE, "literal;not-a-shell", "$(never-execute)"],
      env: {},
      timeout_ms: 1_000,
    },
    owner: "owner",
    ...over,
  } as never;
}

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((value) => value.close()));
});

describe("capability executable session manager", () => {
  test("keeps one initialized process and multiplexes out-of-order responses", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-executable-"));
    const pool = manager();
    const session = await pool.session(input(workspace));
    const again = await pool.session(input(workspace));
    expect(again).toBe(session);
    const slow = session.request("test/slow", {});
    const fast = session.request("test/fast", {});
    await expect(fast).resolves.toBe("fast");
    await expect(slow).resolves.toBe("slow");
    expect(session.providerKind).toBe("fixture");
    expect(session.writable).toBe(true);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("spawns without a shell, from cwd, with inherited and interpolated environment", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-executable-env-"));
    const pool = manager({ INHERITED: "host", SOURCE: "value" });
    const session = await pool.session(
      input(workspace, {
        declaration: {
          command: process.execPath,
          args: [FIXTURE, "literal;not-a-shell", "$(never-execute)"],
          env: { EXPANDED: "${SOURCE}-suffix" },
          timeout_ms: 1_000,
        },
      }),
    );
    const value = (await session.request("test/inspect", {})) as Record<string, unknown>;
    expect(value).toMatchObject({
      cwd: realpathSync(workspace),
      argv: ["literal;not-a-shell", "$(never-execute)"],
      inherited: "host",
      expanded: "value-suffix",
    });
    expect(existsSync(join(workspace, "never-execute"))).toBe(false);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("timeout and cancellation terminate the session and permit a later restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-executable-timeout-"));
    const pool = manager();
    const timed = await pool.session(
      input(workspace, {
        declaration: { command: process.execPath, args: [FIXTURE], env: {}, timeout_ms: 300 },
      }),
    );
    await expect(timed.request("test/hang", {})).rejects.toThrow("timed out");
    const restarted = await pool.session(
      input(workspace, {
        declaration: { command: process.execPath, args: [FIXTURE], env: {}, timeout_ms: 300 },
      }),
    );
    expect(restarted).not.toBe(timed);

    const controller = new AbortController();
    const hanging = restarted.request("test/hang", {}, controller.signal);
    controller.abort(new Error("cancelled by test"));
    await expect(hanging).rejects.toThrow("cancelled by test");
    rmSync(workspace, { recursive: true, force: true });
  });

  test.each([
    ["test/malformed", "invalid JSON"],
    ["test/oversized", "maximum JSON line size"],
    ["test/die", "exited"],
  ])("closes every pending call on protocol failure %s", async (method, message) => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-executable-failure-"));
    const session = await manager().session(input(workspace));
    const pending = session.request("test/slow", {});
    const observedPending = pending.catch((error: unknown) => error);
    const failing = session.request(method, {});
    await expect(failing).rejects.toThrow(message);
    expect(await observedPending).toBeInstanceOf(Error);
    rmSync(workspace, { recursive: true, force: true });
  });

  test.each([
    ["test/non-object", "non-object"],
    ["test/invalid-response", "invalid JSON-RPC response"],
    ["test/unknown-id", "unknown id"],
    ["test/result-and-error", "exactly one"],
    ["test/oversized-line", "maximum JSON line size"],
    ["test/stderr-die", "fixture diagnostic"],
  ])("rejects additional protocol failure %s", async (method, message) => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-executable-edge-"));
    const session = await manager().session(input(workspace));
    await expect(session.request(method, {})).rejects.toThrow(message);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("rejects a pre-aborted request and a command that cannot spawn", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-executable-abort-"));
    const session = await manager().session(input(workspace));
    const controller = new AbortController();
    controller.abort("cancelled before request");
    await expect(session.request("test/fast", {}, controller.signal)).rejects.toThrow(
      "cancelled before request",
    );

    await expect(
      manager().session(
        input(workspace, {
          declaration: { command: "/definitely/missing/clarvis-command", args: [], env: {} },
        }),
      ),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      manager().session(
        input(workspace, {
          declaration: { command: "invalid\0command", args: [], env: {} },
        }),
      ),
    ).rejects.toBeInstanceOf(Error);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("never replays a mutation after process death", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-executable-replay-"));
    const marker = join(workspace, "mutations.txt");
    const pool = manager();
    const session = await pool.session(input(workspace));
    await expect(session.request("test/mutate-die", { path: marker })).rejects.toThrow();
    expect(readFileSync(marker, "utf8")).toBe("mutation\n");
    const restarted = await pool.session(input(workspace));
    await expect(restarted.request("test/read-count", { path: marker })).resolves.toBe(1);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("maps well-formed and malformed JSON-RPC errors", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-executable-rpc-error-"));
    const session = await manager().session(input(workspace));
    const domain = await session.request("test/rpc-error", {}).catch((error: unknown) => error);
    expect(domain).toBeInstanceOf(CapabilityExecutableRpcError);
    expect(domain).toMatchObject({
      message: "fixture conflict",
      rpcCode: -32_001,
      domainCode: "plan_conflict",
    });
    await expect(session.request("test/rpc-error-invalid", {})).rejects.toMatchObject({
      message: "invalid JSON-RPC error response",
      rpcCode: -32_603,
    });
    rmSync(workspace, { recursive: true, force: true });
  });

  test.each([
    ["null", "initialize must return an object"],
    ["version", "unsupported capability executable protocol version"],
    ["kind", "non-empty provider_kind"],
    ["writable", "writable must be boolean"],
    ["missing-writable", "memory initialize must declare writable"],
  ])("rejects invalid initialize result %s", async (mode, message) => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-executable-initialize-"));
    const pool = manager();
    await expect(
      pool.session(
        input(workspace, {
          declaration: {
            command: process.execPath,
            args: [FIXTURE],
            env: { INIT_MODE: mode },
            timeout_ms: 1_000,
          },
        }),
      ),
    ).rejects.toThrow(message);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("plans v1 rejects a second concurrent owner", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-executable-owner-"));
    const pool = manager();
    await pool.session(input(workspace, { capability: "plans", owner: "alice" }));
    await expect(
      pool.session(input(workspace, { capability: "plans", owner: "bob" })),
    ).rejects.toThrow("v1 allows one owner");
    rmSync(workspace, { recursive: true, force: true });
  });

  test("close requests shutdown before terminating the process tree", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-executable-shutdown-"));
    const marker = join(workspace, "shutdown.txt");
    const pool = manager({ SHUTDOWN_MARKER: marker });
    await pool.session(input(workspace));
    await pool.close();
    expect(readFileSync(marker, "utf8")).toBe("shutdown\n");
    rmSync(workspace, { recursive: true, force: true });
  });
});
