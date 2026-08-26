import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createFileSubscriptionStore } from "../../src/subscriptions/store.ts";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "clarvis-subscriptions-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("subscription credential store", () => {
  it("treats absence as an empty V1 file and durably creates private state", async () => {
    const dir = await root();
    const store = createFileSubscriptionStore({ dir });
    expect(await store.read()).toEqual({ ok: true, value: { version: 1, accounts: {} } });

    await store.mutateAccount("openai-codex", () => ({
      account: {
        access_token: "access",
        refresh_token: "refresh",
        expires_at: 10_000,
      },
      result: undefined,
    }));

    if (process.platform !== "win32") {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(store.path())).mode & 0o777).toBe(0o600);
    }
    expect(await store.read()).toEqual({
      ok: true,
      value: {
        version: 1,
        accounts: {
          "openai-codex": {
            access_token: "access",
            refresh_token: "refresh",
            expires_at: 10_000,
          },
        },
      },
    });
  });

  it("refuses malformed state without replacing or deleting it", async () => {
    const dir = await root();
    const store = createFileSubscriptionStore({ dir });
    await writeFile(store.path(), "{ malformed", { mode: 0o600 });
    const before = await readFile(store.path(), "utf8");

    expect(await store.read()).toEqual({ ok: false, diagnostic: "malformed" });
    await expect(
      store.mutateAccount("xai-grok", () => ({ account: undefined, result: undefined })),
    ).rejects.toThrow("repair it manually");
    expect(await readFile(store.path(), "utf8")).toBe(before);
  });

  it("bounds reads and refuses a credential-file symlink", async () => {
    const oversizedRoot = await root();
    const oversized = createFileSubscriptionStore({ dir: oversizedRoot });
    await writeFile(oversized.path(), "x".repeat(1024 * 1024 + 1), { mode: 0o600 });
    expect(await oversized.read()).toEqual({ ok: false, diagnostic: "oversized" });

    const symlinkRoot = await root();
    const target = join(symlinkRoot, "target.json");
    await writeFile(target, '{"version":1,"accounts":{}}', { mode: 0o600 });
    await symlink(target, join(symlinkRoot, "subscriptions.json"));
    expect(await createFileSubscriptionStore({ dir: symlinkRoot }).read()).toEqual({
      ok: false,
      diagnostic: "unsafe_path",
    });
  });

  it("serializes concurrent writers so both subscription accounts survive", async () => {
    const dir = await root();
    await chmod(dir, 0o700);
    const first = createFileSubscriptionStore({ dir, lockWaitMs: 5_000 });
    const second = createFileSubscriptionStore({ dir, lockWaitMs: 5_000 });

    await Promise.all([
      first.mutateAccount("openai-codex", () => ({
        account: { access_token: "oa", refresh_token: "oa-r", expires_at: 10_000 },
        result: undefined,
      })),
      second.mutateAccount("xai-grok", () => ({
        account: { access_token: "xai", refresh_token: "xai-r", expires_at: 10_000 },
        result: undefined,
      })),
    ]);

    const snapshot = await first.read();
    expect(snapshot.ok && Object.keys(snapshot.value.accounts).sort()).toEqual([
      "openai-codex",
      "xai-grok",
    ]);
  });
});
