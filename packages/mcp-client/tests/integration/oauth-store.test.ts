import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMcpOAuthCredentialStore,
  MAX_MCP_OAUTH_STORE_BYTES,
  McpOAuthStoreError,
} from "../../src/oauth-store.ts";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const roots: string[] = [];

async function temporaryStore() {
  const root = await mkdtemp(join(tmpdir(), "clarvis-mcp-oauth-"));
  roots.push(root);
  const state = join(root, "state");
  await mkdir(state);
  const file = join(state, "mcp-oauth.json");
  return { file, store: createMcpOAuthCredentialStore(file) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persistent MCP OAuth credential store", () => {
  it("persists validated credentials privately and reads them back", async () => {
    const { file, store } = await temporaryStore();
    expect(await store.readRecord(KEY_A)).toBeUndefined();

    await store.mutateRecord(KEY_A, () => ({
      redirect_url: "http://127.0.0.1:53682/oauth/callback",
      client_information: { client_id: "client-1" },
      tokens: {
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        token_type: "Bearer",
      },
      updated_at: 42,
    }));

    expect(await store.readRecord(KEY_A)).toEqual({
      redirect_url: "http://127.0.0.1:53682/oauth/callback",
      client_information: { client_id: "client-1" },
      tokens: {
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        token_type: "Bearer",
      },
      updated_at: 42,
    });
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(join(file, ".."))).mode & 0o777).toBe(0o700);
    }
  });

  it("refuses to read or overwrite a malformed credential document", async () => {
    const { file, store } = await temporaryStore();
    await writeFile(file, "not-json\n", { mode: 0o600 });

    const readFailure = await store.readRecord(KEY_A).catch((error: unknown) => error);
    expect(readFailure).toBeInstanceOf(McpOAuthStoreError);
    expect(readFailure).toMatchObject({
      code: "mcp_oauth_store_invalid",
      diagnostic: "malformed",
    });
    await expect(store.mutateRecord(KEY_A, () => ({ updated_at: 1 }))).rejects.toMatchObject({
      diagnostic: "malformed",
    });
    expect(await readFile(file, "utf8")).toBe("not-json\n");
  });

  it("rejects an oversized credential document before parsing", async () => {
    const { file, store } = await temporaryStore();
    await writeFile(file, Buffer.alloc(MAX_MCP_OAUTH_STORE_BYTES + 1, 0x20));

    await expect(store.readRecord(KEY_A)).rejects.toMatchObject({
      diagnostic: "oversized",
    });
  });

  it("applies the per-record ceiling in UTF-8 bytes", async () => {
    const { store } = await temporaryStore();
    await expect(
      store.mutateRecord(KEY_A, () => ({
        updated_at: 1,
        tokens: { access_token: "€".repeat(180_000), token_type: "Bearer" },
      })),
    ).rejects.toThrow("invalid MCP OAuth credential record");
  });

  it.if(process.platform !== "win32")("does not follow a credential-file symlink", async () => {
    const { file, store } = await temporaryStore();
    const target = join(file, "..", "target.json");
    await writeFile(target, '{"version":1,"records":{}}\n');
    await symlink(target, file);

    await expect(store.readRecord(KEY_A)).rejects.toMatchObject({
      diagnostic: "unsafe_path",
    });
  });

  it.if(process.platform !== "win32")(
    "does not read through a symlinked parent directory",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "clarvis-mcp-oauth-parent-"));
      roots.push(root);
      const target = join(root, "target");
      const linked = join(root, "linked");
      await mkdir(target);
      await writeFile(join(target, "mcp-oauth.json"), '{"version":1,"records":{}}\n');
      await symlink(target, linked);
      const store = createMcpOAuthCredentialStore(join(linked, "mcp-oauth.json"));

      await expect(store.readRecord(KEY_A)).rejects.toMatchObject({
        diagnostic: "unsafe_path",
      });
    },
  );

  it("serializes independent writers without losing either record", async () => {
    const { file } = await temporaryStore();
    const first = createMcpOAuthCredentialStore(file);
    const second = createMcpOAuthCredentialStore(file);

    await Promise.all([
      first.mutateRecord(KEY_A, () => ({ updated_at: 1 })),
      second.mutateRecord(KEY_B, () => ({ updated_at: 2 })),
    ]);

    expect(await first.readRecord(KEY_A)).toEqual({ updated_at: 1 });
    expect(await first.readRecord(KEY_B)).toEqual({ updated_at: 2 });
  });
});
