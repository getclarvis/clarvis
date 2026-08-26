import { mkdtempSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { isPrivateLanBind } from "../../src/config/env.ts";

// `src/bin.ts` is a real executable entry point (`#!/usr/bin/env bun`, a
// top-level `await main(...)`), so it cannot be imported from a test without
// either running its whole CLI in this process or starting a real server.
// These tests spawn it as a genuine subprocess and assert on its externally
// observable contract - exit code and the message on stderr - which is what
// AGENTS.md names as the inviolable invariant: "a non-private --host exits 1
// without --allow-public-bind". Bun's own coverage instrumentation only sees
// code that runs inside the `bun test` process, so this file cannot move
// `src/bin.ts` off `NO_COUNTER_ALLOWLIST` in tooling/checks/coverage.ts; see
// the allowlist's own comment for why removing the entry is out of reach
// without either running the suite with `--isolate` or splitting the gate
// into a directly importable function.

const binPath = fileURLToPath(new URL("../../src/bin.ts", import.meta.url));

/** Bind-address related keys `bin.ts` reads from the ambient environment. */
const AMBIENT_KEYS_TO_CLEAR = [
  "CLARVIS_WORKSPACE_ROOT",
  "CLARVIS_HOME",
  "CLARVIS_LOG_LEVEL",
] as const;

/**
 * A `process.env` for spawning `bin.ts` with no leftover `CLARVIS_SERVER_*`
 * state from the host shell, so the gate's outcome depends only on the argv
 * this test passes.
 */
function binEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLARVIS_LOG_LEVEL: "info" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLARVIS_SERVER_")) delete env[key];
  }
  for (const key of AMBIENT_KEYS_TO_CLEAR) delete env[key];
  env.CLARVIS_LOG_LEVEL = "info";
  return env;
}

/** A fresh, empty directory for `--workspace`/`--config`. */
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "clarvis-server-bin-gate-"));
}

/**
 * Spawns `bin.ts` as a real `bun` subprocess.
 *
 * @remarks `timeout`/`killSignal` are a last-resort safety net (the gate
 * resolves in milliseconds, and {@link readUntilSettled} reaps the process as
 * soon as it has an answer) against the suite ever hanging on a run that,
 * against expectation, keeps serving with neither marker ever appearing.
 */
function spawnBin(args: string[]) {
  return Bun.spawn([process.execPath, binPath, ...args], {
    env: binEnv(),
    stdout: "ignore",
    stderr: "pipe",
    stdin: "ignore",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
}

/** The two mutually exclusive outcomes a run of `bin.ts` settles on. */
const GATE_MARKERS = [
  "refusing a non-private bind address",
  "refusing a local-network bind address",
  "listening",
] as const;

/**
 * Reads `bin.ts`'s stderr until one of {@link GATE_MARKERS} appears (or a
 * bound is hit), then kills the process and returns its accumulated stderr
 * and exit code.
 *
 * @remarks A refusal ends the process on its own; a pass keeps serving
 * indefinitely, so this is what lets the "passes the gate" tests finish in
 * milliseconds instead of riding out {@link spawnBin}'s full safety timeout.
 *
 * The marker reaching stderr does *not* mean the process has exited — it means
 * it has decided to. Killing straight away raced that teardown and reported the
 * refusal cases as `137` (SIGKILL) instead of the `1` the gate's contract
 * names, intermittently, on whichever runner was slowest that day. So a refusal
 * is now given a bounded grace period to exit on its own, and the kill stays
 * only for the "keeps serving" case it exists for.
 */
async function readUntilSettled(
  proc: ReturnType<typeof spawnBin>,
  timeoutMs: number,
): Promise<{ stderr: string; code: number }> {
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let stderr = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const outcome = await Promise.race([
        reader.read(),
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), remaining)),
      ]);
      if (outcome === "timed-out") break;
      if (outcome.done) break;
      stderr += decoder.decode(outcome.value, { stream: true });
      if (GATE_MARKERS.some((marker) => stderr.includes(marker))) break;
    }
  } finally {
    reader.releaseLock();
  }

  const refused = stderr.includes("refusing a");
  if (refused) {
    const exitedNaturally = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (exitedNaturally) return { stderr, code: await proc.exited };
  }
  proc.kill("SIGKILL");
  return { stderr, code: await proc.exited };
}

/** The first real, non-internal RFC1918 address this machine actually owns. */
function ownLanAddress(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal && isPrivateLanBind(addr.address)) {
        return addr.address;
      }
    }
  }
  return undefined;
}

describe("clarvis-server bin: fail-closed bind-address gate", () => {
  it("exits 1 refusing a public bind address with no --allow-public-bind and auth off", async () => {
    const proc = spawnBin(["--host", "0.0.0.0", "--port", "0"]);
    const { stderr, code } = await readUntilSettled(proc, 5_000);
    expect(stderr).toContain("refusing a non-private bind address");
    expect(code).toBe(1);
  });

  it("exits 1 refusing an RFC1918 bind address with no --allow-lan-bind and auth off", async () => {
    const proc = spawnBin(["--host", "10.99.99.99", "--port", "0"]);
    const { stderr, code } = await readUntilSettled(proc, 5_000);
    expect(stderr).toContain("refusing a local-network bind address");
    expect(code).toBe(1);
  });

  it("does not refuse the default loopback bind with no flags at all", async () => {
    const proc = spawnBin([
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--workspace",
      freshDir(),
      "--config",
      freshDir(),
    ]);
    const { stderr, code } = await readUntilSettled(proc, 8_000);
    expect(stderr).not.toContain("refusing a non-private bind address");
    expect(stderr).not.toContain("refusing a local-network bind address");
    expect(stderr).toContain("listening");
    expect(code).not.toBe(1);
  });

  it("passes the public-bind gate once --allow-public-bind is set, and starts listening", async () => {
    const proc = spawnBin([
      "--host",
      "0.0.0.0",
      "--port",
      "0",
      "--allow-public-bind",
      "--workspace",
      freshDir(),
      "--config",
      freshDir(),
    ]);
    const { stderr, code } = await readUntilSettled(proc, 8_000);
    expect(stderr).not.toContain("refusing a non-private bind address");
    expect(stderr).toContain("listening");
    expect(code).not.toBe(1);
  });

  // Binding actually requires an address this machine owns (bin.ts binds the
  // literal --host value), unlike the refusal tests above, whose exit(1)
  // happens before any socket is ever opened. Skips cleanly on a host with no
  // RFC1918 interface rather than asserting against an address nothing owns.
  const lanAddress = ownLanAddress();
  it.skipIf(lanAddress === undefined)(
    "passes the LAN-bind gate once --allow-lan-bind is set, and starts listening",
    async () => {
      const proc = spawnBin([
        "--host",
        lanAddress ?? "0.0.0.0",
        "--port",
        "0",
        "--allow-lan-bind",
        "--workspace",
        freshDir(),
        "--config",
        freshDir(),
      ]);
      const { stderr, code } = await readUntilSettled(proc, 8_000);
      expect(stderr).not.toContain("refusing a local-network bind address");
      expect(stderr).toContain("listening");
      expect(code).not.toBe(1);
    },
  );
});
