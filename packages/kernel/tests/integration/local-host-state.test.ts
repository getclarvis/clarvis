import { afterEach, describe, expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireLocalHostState,
  localHostEndpointRootCandidates,
  localHostProcessAlive,
  readLocalHostConnection,
  resolveLocalHostIdentity,
  type LocalHostState,
} from "../../src/hosting/local-state.ts";
import { readPrivateHostJson } from "../../src/hosting/private-files.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clarvis-host-state-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const identity = await resolveLocalHostIdentity({
    workspaceRoot,
    globalDir: join(root, "global"),
    owner: "operator",
  });
  const acquire = async (): Promise<LocalHostState> => {
    const state = await acquireLocalHostState(identity, "test-artifact", "0".repeat(64));
    if (state === null) throw new Error("fixture unexpectedly contended");
    cleanups.push(() => state.close());
    return state;
  };
  return { root, workspaceRoot, identity, acquire };
}

describe("private local host state", () => {
  test("derives ordered endpoint roots from only absolute temp variables", () => {
    expect(
      localHostEndpointRootCandidates({ TMPDIR: "/tmpdir", TMP: "/tmp-value", TEMP: "/temp" }),
    ).toEqual(["/tmpdir", "/tmp"]);
    expect(
      localHostEndpointRootCandidates({ TMPDIR: "", TMP: "/tmp-value", TEMP: "/temp" }),
    ).toEqual(["/tmp-value", "/tmp"]);
    expect(localHostEndpointRootCandidates({ TMPDIR: "relative", TMP: "", TEMP: "/temp" })).toEqual(
      ["/temp", "/tmp"],
    );
    expect(localHostEndpointRootCandidates({ TMPDIR: "relative", TMP: "also-relative" })).toEqual([
      "/tmp",
    ]);
    expect(localHostEndpointRootCandidates({ TMPDIR: "/tmp", TMP: "/ignored" })).toEqual(["/tmp"]);
    expect(
      localHostEndpointRootCandidates({
        CLARVIS_HOME: "/unrelated",
        HOME: "/also-unrelated",
        PATH: "/bin",
      }),
    ).toEqual(["/tmp"]);
  });

  test("keeps identity stable for one snapshot and publishes a long-temp fallback record", async () => {
    const f = await fixture();
    const environment = {
      TMPDIR: join("/tmp", "incident-" + "a".repeat(168)),
      TMP: join("/tmp", "other-" + "b".repeat(168)),
      TEMP: join("/tmp", "third-" + "c".repeat(168)),
      UNRELATED_SECRET: "does-not-select-an-endpoint",
    };
    const input = {
      workspaceRoot: f.workspaceRoot,
      globalDir: join(f.root, "snapshot-global"),
      owner: "operator",
      endpointRootCandidates: localHostEndpointRootCandidates(environment),
    };
    const first = await resolveLocalHostIdentity(input);
    const second = await resolveLocalHostIdentity({
      ...input,
      endpointRootCandidates: localHostEndpointRootCandidates({
        ...environment,
        UNRELATED_SECRET: "changed",
      }),
    });
    expect(second.paths.endpoint).toBe(first.paths.endpoint);
    expect(first.paths.endpointDirectory).toStartWith(`${resolve("/tmp")}/clv-`);
    expect(Buffer.byteLength(first.paths.endpoint, "utf8")).toBeLessThanOrEqual(100);
    const state = await acquireLocalHostState(first, "test-artifact", "0".repeat(64));
    if (state === null) throw new Error("snapshot fixture unexpectedly contended");
    cleanups.push(() => state.close());
    await state.publish("workspace");
    expect((await readLocalHostConnection(first))?.endpoint).toBe(first.paths.endpoint);
  });

  test("projection storage is generation-owned and terminal reclamation is idempotent", async () => {
    const f = await fixture();
    const state = await f.acquire();
    const projection = await state.storage.projection("run-1");
    try {
      await projection.append({ type: "run_started", at: 1 });
      await projection.sync();
    } finally {
      await projection.close();
    }
    const file = f.identity.paths.projectionFile(state.generation, "run-1");
    expect(await readFile(file, "utf8")).toContain("run_started");
    const index = {
      schema_version: 1 as const,
      host_generation: state.generation,
      runs: [],
      receipts: [],
    };
    await state.storage.commit(index);
    await state.close();
    const next = await f.acquire();
    expect(next.storage.initialState).toEqual(index);
    await expect(next.storage.commit(index)).rejects.toMatchObject({ code: "conflict" });
    await next.storage.removeProjection("run-1", state.generation);
    await next.storage.removeProjection("run-1", state.generation);
    await next.storage.removeProjection("missing", "unretained-generation");
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    await next.close();
    await expect(next.storage.projection("late-run")).rejects.toThrow("lease");
  });

  test("holds one lease, authenticates a private credential and fences storage after retirement", async () => {
    const f = await fixture();
    expect(await readLocalHostConnection(f.identity)).toBeNull();
    const state = await f.acquire();
    expect(await acquireLocalHostState(f.identity, "test-artifact", "0".repeat(64))).toBeNull();
    await state.publish("workspace");
    const record = (await readLocalHostConnection(f.identity))!;
    expect(state.authenticate(record.credential)).toBe("operator");
    expect(state.authenticate("0".repeat(64))).toBeUndefined();
    expect(state.authenticate(undefined)).toBeUndefined();
    const index = {
      schema_version: 1 as const,
      host_generation: state.generation,
      runs: [],
      receipts: [],
    };
    await state.storage.commit(index);
    expect(await readFile(f.identity.paths.registryFile, "utf8")).not.toContain(record.credential);
    await state.close();
    expect(await readLocalHostConnection(f.identity)).toBeNull();
    expect(state.authenticate(record.credential)).toBeUndefined();
    await expect(state.storage.commit(index)).rejects.toThrow("lease");
  });

  test("never replaces a connection record naming a possibly live process", async () => {
    const f = await fixture();
    const state = await f.acquire();
    await state.publish("workspace");
    const original = await readFile(f.identity.paths.connectionFile, "utf8");
    await state.lease.release();
    await expect(
      acquireLocalHostState(f.identity, "test-artifact", "0".repeat(64)),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await readFile(f.identity.paths.connectionFile, "utf8")).toBe(original);
    expect(localHostProcessAlive(0)).toBe(true);
    expect(localHostProcessAlive(process.pid)).toBe(true);
  });

  test("refuses host credentials within the writable workspace", async () => {
    const f = await fixture();
    await expect(
      resolveLocalHostIdentity({
        workspaceRoot: f.workspaceRoot,
        globalDir: join(f.workspaceRoot, "operator"),
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  test("discovery tolerates publication retirement during concurrent reads", async () => {
    const f = await fixture();
    for (let attempt = 0; attempt < 16; attempt++) {
      const state = await f.acquire();
      await state.publish("workspace");
      const reading = Array.from({ length: 8 }, () => readLocalHostConnection(f.identity));
      await state.close();
      for (const record of await Promise.all(reading))
        expect(record === null || record.host_generation === state.generation).toBe(true);
      expect(await readLocalHostConnection(f.identity)).toBeNull();
    }
  });

  test("bounds disk input and refuses invalid records without echoing their contents", async () => {
    const f = await fixture();
    await f.acquire();
    const file = f.identity.paths.connectionFile;
    await writeFile(file, "x".repeat(16 * 1024 + 1), { mode: 0o600 });
    await expect(readLocalHostConnection(f.identity)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await writeFile(file, JSON.stringify({ credential: "not-a-real-provider-secret" }));
    await expect(readLocalHostConnection(f.identity)).rejects.toMatchObject({
      message: "local host connection record is invalid",
    });
  });

  test("refuses permissive, symbolic and hardlinked credential files", async () => {
    const f = await fixture();
    await f.acquire();
    const file = f.identity.paths.connectionFile;
    await writeFile(file, "{}", { mode: 0o644 });
    await expect(readPrivateHostJson(file, 1024)).rejects.toMatchObject({ code: "unauthorized" });
    await chmod(file, 0o600);
    const other = join(f.root, "linked.json");
    await link(file, other);
    await expect(readPrivateHostJson(file, 1024)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await rm(file);
    await symlink(other, file);
    await expect(readPrivateHostJson(file, 1024)).rejects.toBeDefined();
  });
});
