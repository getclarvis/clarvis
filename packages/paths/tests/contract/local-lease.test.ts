import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  acquireLocalLease,
  acquireLocalLeaseSync,
  LocalLeaseLostError,
  reclaimLocalLease,
  reclaimLocalLeaseSync,
  setPathsLogger,
  type LocalLeaseRecord,
  type PathsLogger,
} from "@clarvis/paths";

import { recorder } from "../helpers/recorder.ts";

const made: string[] = [];

function fixture(name = "lease.lock"): string {
  const dir = mkdtempSync(join(tmpdir(), "clarvis-local-lease-"));
  made.push(dir);
  return join(dir, name);
}

function age(path: string, ms: number): void {
  const stale = new Date(Date.now() - ms);
  utimesSync(path, stale, stale);
}

function seed(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o600 });
}

afterEach(() => {
  setPathsLogger(null);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("local filesystem leases", () => {
  test("publishes one complete owner record and releases only the holder", async () => {
    const path = fixture();
    const lease = await acquireLocalLease(path, {
      staleMs: 30_000,
      token: () => "owner-a",
    });
    expect(lease).not.toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8")) as LocalLeaseRecord).toMatchObject({
      version: 1,
      pid: process.pid,
      token: "owner-a",
      host: hostname(),
    });
    expect(
      await acquireLocalLease(path, { staleMs: 30_000, waitMs: 0, token: () => "owner-b" }),
    ).toBeNull();
    expect(await lease!.owned()).toBe(true);
    await expect(lease!.assertOwned()).resolves.toBeUndefined();
    expect(await lease!.release()).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(await lease!.release()).toBe(false);
  });

  test("retires an async publication when its recovery recheck fails", async () => {
    const path = fixture();
    const recoveryPath = `${path}.recovery`;
    await expect(
      acquireLocalLease(path, {
        staleMs: 30_000,
        token: () => "abandoned-async-publication",
        afterPublish() {
          writeFileSync(recoveryPath, "not a recovery directory");
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(existsSync(path)).toBe(false);
    rmSync(recoveryPath);

    const successor = await acquireLocalLease(path, {
      staleMs: 30_000,
      token: () => "async-after-failure",
    });
    expect(successor?.record.token).toBe("async-after-failure");
    await successor?.release();
  });

  test("the synchronous variant publishes, excludes a contender, and releases", () => {
    const path = fixture();
    const lease = acquireLocalLeaseSync(path, {
      staleMs: 30_000,
      token: () => "sync-owner",
    });
    expect(lease?.record).toMatchObject({
      version: 1,
      pid: process.pid,
      token: "sync-owner",
      host: hostname(),
    });
    expect(
      acquireLocalLeaseSync(path, {
        staleMs: 30_000,
        token: () => "sync-contender",
      }),
    ).toBeNull();
    expect(lease!.release()).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(lease!.release()).toBe(false);
  });

  test("retires a synchronous publication when its recovery recheck fails", () => {
    const path = fixture();
    const recoveryPath = `${path}.recovery`;
    expect(() =>
      acquireLocalLeaseSync(path, {
        staleMs: 30_000,
        token: () => "abandoned-sync-publication",
        afterPublish() {
          writeFileSync(recoveryPath, "not a recovery directory");
        },
      }),
    ).toThrow();
    expect(existsSync(path)).toBe(false);
    rmSync(recoveryPath);

    const successor = acquireLocalLeaseSync(path, {
      staleMs: 30_000,
      token: () => "sync-after-failure",
    });
    expect(successor?.record.token).toBe("sync-after-failure");
    expect(successor?.release()).toBe(true);
  });

  test("the synchronous acquisition path reclaims a stale partial publisher", () => {
    const path = fixture();
    seed(path, "{");
    age(path, 60_000);
    const lease = acquireLocalLeaseSync(path, {
      staleMs: 30_000,
      token: () => "sync-recovered",
    });
    expect(lease?.record.token).toBe("sync-recovered");
    expect(lease?.release()).toBe(true);
  });

  test("renews through the held inode while protected work is running", async () => {
    const path = fixture();
    const lease = await acquireLocalLease(path, {
      staleMs: 1_000,
      heartbeatMs: 5,
    });
    expect(lease).not.toBeNull();
    const acquired = statSync(path).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(statSync(path).mtimeMs).toBeGreaterThan(acquired);
    await lease!.release();
  });

  test("coalesces heartbeat pressure and release drains only the active renewal", async () => {
    const path = fixture();
    const renewGates: Array<() => void> = [];
    let renewals = 0;
    const lease = await acquireLocalLease(path, {
      staleMs: 1_000,
      heartbeatMs: 1,
      beforeRenew: () =>
        new Promise<void>((resolve) => {
          renewals += 1;
          renewGates.push(resolve);
        }),
    });
    expect(lease).not.toBeNull();
    const waitForRenewals = async (expected: number): Promise<void> => {
      for (let attempt = 0; attempt < 100 && renewals < expected; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(renewals).toBe(expected);
    };

    try {
      await waitForRenewals(1);
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(renewals).toBe(1);
      renewGates.shift()?.();
      await waitForRenewals(2);
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(renewals).toBe(2);

      let released = false;
      const release = lease!.release().then((result) => {
        released = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(released).toBe(false);
      renewGates.shift()?.();
      expect(await release).toBe(true);
      expect(renewals).toBe(2);
    } finally {
      for (const openGate of renewGates.splice(0)) openGate();
      await lease?.release();
    }
  });

  test.each(["", '{"version":1'])(
    "recovers a stale empty or partial canonical record: %p",
    async (body) => {
      const path = fixture();
      seed(path, body);
      age(path, 60_000);
      const lease = await acquireLocalLease(path, {
        staleMs: 30_000,
        waitMs: 0,
        token: () => "recovered",
      });
      expect(lease?.record.token).toBe("recovered");
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ token: "recovered" });
      await lease?.release();
    },
  );

  test("does not reclaim a fresh partial record", async () => {
    const path = fixture();
    seed(path, "{");
    expect(await acquireLocalLease(path, { staleMs: 30_000, waitMs: 0 })).toBeNull();
    expect(readFileSync(path, "utf8")).toBe("{");
  });

  test("does not reclaim a stale lease whose same-host process is live", async () => {
    const path = fixture();
    seed(
      path,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        token: "live",
        acquiredAt: 1,
        host: hostname(),
      }),
    );
    age(path, 60_000);
    expect(
      await acquireLocalLease(path, {
        staleMs: 0,
        waitMs: 0,
      }),
    ).toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ token: "live" });
  });

  test("fails closed for a stale lease owned by another host", async () => {
    const path = fixture();
    seed(
      path,
      JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        token: "foreign",
        acquiredAt: 1,
        host: "another-host",
      }),
    );
    age(path, 60_000);
    expect(await acquireLocalLease(path, { staleMs: 0, waitMs: 0 })).toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ token: "foreign" });
  });

  test("reclaims a stale lease only after its owner is known dead", async () => {
    const path = fixture();
    seed(
      path,
      JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        token: "dead",
        acquiredAt: 1,
        host: hostname(),
      }),
    );
    age(path, 60_000);
    const lease = await acquireLocalLease(path, {
      staleMs: 0,
      waitMs: 0,
      token: () => "successor",
    });
    expect(lease?.record.token).toBe("successor");
    await lease?.release();
  });

  test("two stale-lock reclaimers still publish at most one successor", async () => {
    const path = fixture();
    seed(path, "");
    age(path, 60_000);
    let token = 0;
    const contenders = await Promise.all([
      acquireLocalLease(path, {
        staleMs: 0,
        waitMs: 0,
        token: () => `contender-${++token}`,
      }),
      acquireLocalLease(path, {
        staleMs: 0,
        waitMs: 0,
        token: () => `contender-${++token}`,
      }),
    ]);
    expect(contenders.filter((lease) => lease !== null)).toHaveLength(1);
    await Promise.all(contenders.map((lease) => lease?.release()));
  });

  test("treats a non-positive pid as live rather than guessing that it is dead", async () => {
    const path = fixture();
    seed(path, JSON.stringify({ version: 1, pid: 0, token: "unknown-owner", acquiredAt: 1 }));
    age(path, 60_000);
    expect(await acquireLocalLease(path, { staleMs: 0, waitMs: 0 })).toBeNull();
  });

  test("waits boundedly for a current holder to release", async () => {
    const path = fixture();
    const first = await acquireLocalLease(path, { staleMs: 30_000 });
    expect(first).not.toBeNull();
    const release = setTimeout(() => void first!.release(), 5);
    const second = await acquireLocalLease(path, {
      staleMs: 30_000,
      waitMs: 100,
      retryMs: 10,
    });
    clearTimeout(release);
    expect(second).not.toBeNull();
    await second!.release();
  });

  test("preserves a successor introduced before async quarantine", async () => {
    const path = fixture();
    seed(path, "");
    age(path, 60_000);
    const successor = JSON.stringify({
      version: 1,
      pid: process.pid,
      token: "async-successor",
      acquiredAt: Date.now(),
    });
    expect(
      await reclaimLocalLease(path, {
        staleMs: 0,
        beforeReclaim() {
          unlinkSync(path);
          seed(path, successor);
        },
      }),
    ).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ token: "async-successor" });
  });

  test("never detaches a raced successor after observing an older stale lease", async () => {
    const path = fixture();
    seed(path, "");
    age(path, 60_000);
    let moved = false;
    const successor = JSON.stringify({
      version: 1,
      pid: process.pid,
      token: "raced-live-successor",
      acquiredAt: Date.now(),
      host: hostname(),
    });

    expect(
      await reclaimLocalLease(path, {
        staleMs: 0,
        beforeReclaim() {
          unlinkSync(path);
          seed(path, successor);
        },
        afterReclaimMove() {
          moved = true;
        },
      }),
    ).toBe(false);
    expect(moved).toBe(false);
    expect(
      acquireLocalLeaseSync(path, {
        staleMs: 0,
        token: () => "third-contender",
      }),
    ).toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      token: "raced-live-successor",
    });
  });

  test("keeps third contenders out while a stale canonical entry is quarantined", async () => {
    const path = fixture();
    seed(path, "");
    age(path, 60_000);
    let third: ReturnType<typeof acquireLocalLeaseSync> | undefined;

    expect(
      await reclaimLocalLease(path, {
        staleMs: 0,
        afterReclaimMove() {
          third = acquireLocalLeaseSync(path, {
            staleMs: 0,
            token: () => "quarantine-contender",
          });
        },
      }),
    ).toBe(true);
    expect(third).toBeNull();
    const successor = await acquireLocalLease(path, {
      staleMs: 0,
      token: () => "after-recovery",
    });
    expect(successor?.record.token).toBe("after-recovery");
    await successor?.release();
  });

  test("keeps the recovery namespace stable after intents retire", async () => {
    const path = fixture();
    const recoveryDir = `${path}.recovery`;
    seed(path, "");
    age(path, 60_000);

    expect(await reclaimLocalLease(path, { staleMs: 0 })).toBe(true);
    expect(statSync(recoveryDir).isDirectory()).toBe(true);
    expect(readdirSync(recoveryDir)).toEqual([]);

    seed(path, "");
    age(path, 60_000);
    expect(reclaimLocalLeaseSync(path, { staleMs: 0 })).toBe(true);
    expect(statSync(recoveryDir).isDirectory()).toBe(true);
    expect(readdirSync(recoveryDir)).toEqual([]);
  });

  test.if(process.platform !== "win32")(
    "a late release cannot unlink a successor with another token and inode",
    async () => {
      const path = fixture();
      const first = await acquireLocalLease(path, {
        staleMs: 30_000,
        token: () => "first",
      });
      expect(first).not.toBeNull();
      unlinkSync(path);
      const second = await acquireLocalLease(path, {
        staleMs: 30_000,
        token: () => "second",
      });
      expect(second).not.toBeNull();
      await expect(first!.assertOwned()).rejects.toBeInstanceOf(LocalLeaseLostError);
      expect(await first!.release()).toBe(false);
      expect(await second!.owned()).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ token: "second" });
      await second!.release();
    },
  );

  test("release atomically restores a successor installed after its ownership check", async () => {
    const path = fixture();
    let successor: Awaited<ReturnType<typeof acquireLocalLease>>;
    const first = await acquireLocalLease(path, {
      staleMs: 30_000,
      token: () => "first",
      async beforeRelease() {
        unlinkSync(path);
        successor = await acquireLocalLease(path, {
          staleMs: 30_000,
          token: () => "successor-during-release",
        });
      },
    });
    expect(first).not.toBeNull();
    expect(await first!.release()).toBe(false);
    expect(successor!).not.toBeNull();
    expect(await successor!.owned()).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      token: "successor-during-release",
    });
    await successor!.release();
  });

  test("a synchronous late release also restores a raced successor", () => {
    const path = fixture();
    let successor: ReturnType<typeof acquireLocalLeaseSync>;
    const first = acquireLocalLeaseSync(path, {
      staleMs: 30_000,
      token: () => "sync-first",
      beforeRelease() {
        unlinkSync(path);
        successor = acquireLocalLeaseSync(path, {
          staleMs: 30_000,
          token: () => "sync-release-successor",
        });
      },
    });
    expect(first).not.toBeNull();
    expect(first!.release()).toBe(false);
    expect(successor!).not.toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      token: "sync-release-successor",
    });
    expect(successor!.release()).toBe(true);
  });

  test.if(process.platform !== "win32" && process.getuid?.() !== 0)(
    "recovers the exact retired inode after release cleanup fails",
    async () => {
      const path = fixture();
      const lease = await acquireLocalLease(path, {
        staleMs: 30_000,
        token: () => "retired-owner",
      });
      expect(lease).not.toBeNull();

      const parent = dirname(path);
      chmodSync(parent, 0o500);
      try {
        expect(await lease!.release()).toBe(false);
        expect(existsSync(path)).toBe(true);
      } finally {
        chmodSync(parent, 0o700);
      }

      const successor = await acquireLocalLease(path, {
        staleMs: 30_000,
        waitMs: 0,
        token: () => "successor-after-release-failure",
      });
      expect(successor?.record.token).toBe("successor-after-release-failure");
      await successor?.release();
    },
  );

  test.if(process.platform !== "win32" && process.getuid?.() !== 0)(
    "the synchronous variant recovers its exact retired inode after release failure",
    () => {
      const path = fixture();
      const lease = acquireLocalLeaseSync(path, {
        staleMs: 30_000,
        token: () => "sync-retired-owner",
      });
      expect(lease).not.toBeNull();

      const parent = dirname(path);
      chmodSync(parent, 0o500);
      try {
        expect(lease!.release()).toBe(false);
      } finally {
        chmodSync(parent, 0o700);
      }

      const successor = acquireLocalLeaseSync(path, {
        staleMs: 30_000,
        token: () => "sync-retired-successor",
      });
      expect(successor?.record.token).toBe("sync-retired-successor");
      expect(successor?.release()).toBe(true);
    },
  );

  test("the synchronous recovery path applies the same malformed-record grace", () => {
    const path = fixture();
    seed(path, "");
    expect(reclaimLocalLeaseSync(path, { staleMs: 30_000 })).toBe(false);
    age(path, 60_000);
    expect(reclaimLocalLeaseSync(path, { staleMs: 30_000 })).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("the synchronous reclaimer also preserves a successor before quarantine", () => {
    const path = fixture();
    seed(path, "");
    age(path, 60_000);
    const successor = JSON.stringify({
      version: 1,
      pid: process.pid,
      token: "sync-successor",
      acquiredAt: Date.now(),
    });
    expect(
      reclaimLocalLeaseSync(path, {
        staleMs: 0,
        beforeReclaim() {
          unlinkSync(path);
          seed(path, successor);
        },
      }),
    ).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ token: "sync-successor" });
  });
});

describe("lease diagnostics", () => {
  test("taking a dead holder's lock is reported with the record it displaced", async () => {
    const path = fixture();
    seed(
      path,
      JSON.stringify({
        version: 1,
        pid: 424_242,
        token: "departed",
        acquiredAt: Date.now(),
        host: hostname(),
      }),
    );
    age(path, 60_000);
    const sink = recorder();
    expect(
      await reclaimLocalLease(path, {
        staleMs: 0,
        processAlive: () => false,
        logger: sink.logger,
      }),
    ).toBe(true);
    const [reclaimed] = sink.events("paths.lease_reclaimed");
    expect(reclaimed).toMatchObject({
      path,
      prior_pid: 424_242,
      prior_host: hostname(),
      reason: "dead_pid",
    });
    expect(reclaimed?.age_ms).toBeGreaterThan(0);
  });

  test("a legacy empty record is reclaimed for a different, named reason", () => {
    const path = fixture();
    seed(path, "");
    age(path, 60_000);
    const sink = recorder();
    expect(reclaimLocalLeaseSync(path, { staleMs: 0, logger: sink.logger })).toBe(true);
    expect(sink.events("paths.lease_reclaimed")[0]).toMatchObject({
      path,
      prior_pid: null,
      prior_host: null,
      reason: "no_record",
    });
  });

  test("an aborted reclamation names the step, not just the contention it looks like", async () => {
    const path = fixture();
    seed(path, "");
    age(path, 60_000);
    const sink = recorder();
    expect(
      await reclaimLocalLease(path, {
        staleMs: 0,
        logger: sink.logger,
        beforeReclaim() {
          unlinkSync(path);
          seed(
            path,
            JSON.stringify({
              version: 1,
              pid: process.pid,
              token: "successor",
              acquiredAt: Date.now(),
              host: hostname(),
            }),
          );
        },
      }),
    ).toBe(false);
    expect(sink.events("paths.lease_reclaim_refused")[0]).toMatchObject({
      path,
      stage: "identity_changed",
    });
    expect(sink.events("paths.lease_reclaimed")).toEqual([]);
  });

  test("a holder that loses its lease on a heartbeat says so, and names the phase", async () => {
    const path = fixture();
    const sink = recorder();
    const lease = await acquireLocalLease(path, {
      staleMs: 30_000,
      token: () => "renew-owner",
      logger: sink.logger,
      beforeRenew() {
        throw new Error("simulated heartbeat failure");
      },
    });
    expect(lease).not.toBeNull();
    let released: boolean | undefined;
    try {
      expect(await lease?.renew()).toBe(false);
      expect(sink.events("paths.lease_lost")[0]).toMatchObject({
        path,
        token: "renew-owner",
        phase: "renew",
      });
    } finally {
      released = await lease?.release();
    }
    expect(released).toBe(false);
  });

  test("a throwing sink cannot make a completed reclamation report contention", async () => {
    const path = fixture();
    seed(path, "");
    age(path, 60_000);
    const sink = recorder();
    const hostile: PathsLogger = {
      ...sink.logger,
      warn() {
        throw new Error("hostile sink");
      },
    };
    expect(await reclaimLocalLease(path, { staleMs: 0, logger: hostile })).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("a throwing sink cannot make a completed synchronous reclamation report contention", () => {
    const path = fixture();
    seed(path, "");
    age(path, 60_000);
    const sink = recorder();
    const hostile: PathsLogger = {
      ...sink.logger,
      warn() {
        throw new Error("hostile sink");
      },
    };
    expect(reclaimLocalLeaseSync(path, { staleMs: 0, logger: hostile })).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("a throwing sink cannot turn a refused reclamation into a rejection", async () => {
    const path = fixture();
    seed(path, "");
    age(path, 60_000);
    const sink = recorder();
    const hostile: PathsLogger = {
      ...sink.logger,
      debug() {
        throw new Error("hostile sink");
      },
    };
    expect(
      await reclaimLocalLease(path, {
        staleMs: 0,
        logger: hostile,
        beforeReclaim() {
          unlinkSync(path);
          seed(
            path,
            JSON.stringify({
              version: 1,
              pid: process.pid,
              token: "successor",
              acquiredAt: Date.now(),
              host: hostname(),
            }),
          );
        },
      }),
    ).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  test("a throwing sink cannot turn a lost heartbeat into a rejection", async () => {
    const path = fixture();
    const sink = recorder();
    const hostile: PathsLogger = {
      ...sink.logger,
      warn() {
        throw new Error("hostile sink");
      },
    };
    const lease = await acquireLocalLease(path, {
      staleMs: 30_000,
      token: () => "renew-owner",
      logger: hostile,
      beforeRenew() {
        throw new Error("simulated heartbeat failure");
      },
    });
    expect(await lease?.renew()).toBe(false);
    await lease?.release();
  });

  test("waiting on a live holder is visible as contention rather than as a stall", async () => {
    const path = fixture();
    const held = await acquireLocalLease(path, { staleMs: 30_000, token: () => "holder" });
    const sink = recorder();
    try {
      expect(
        await acquireLocalLease(path, {
          staleMs: 30_000,
          waitMs: 20,
          retryMs: 5,
          logger: sink.logger,
        }),
      ).toBeNull();
      const contended = sink.events("paths.lease_contended");
      expect(contended.length).toBeGreaterThan(0);
      expect(contended[0]).toMatchObject({ path, attempt: 0, waited_ms: 0 });
    } finally {
      await held?.release();
    }
  });
});
