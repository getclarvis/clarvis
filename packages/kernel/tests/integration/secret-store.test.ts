import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, it, expect } from "bun:test";
import { createFileSecretStore, createSecretService } from "../../src/index.ts";
import { globalPaths } from "@clarvis/paths";

/** Write a fixture file, creating the scope subdirectory it now lives in. */
function seedFile(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "clarvis-secrets-"));
}

describe("createFileSecretStore", () => {
  it("reads empty when keys.json is absent, then round-trips set/read/delete", () => {
    const dir = tmp();
    const store = createFileSecretStore({ dir });
    expect(store.read().values).toEqual({});
    store.set("ANTHROPIC_API_KEY", "sk-abc");
    store.set("OPENAI_API_KEY", "sk-def");
    expect(store.read().values).toEqual({ ANTHROPIC_API_KEY: "sk-abc", OPENAI_API_KEY: "sk-def" });
    store.delete("OPENAI_API_KEY");
    expect(store.read().values).toEqual({ ANTHROPIC_API_KEY: "sk-abc" });
    expect(store.path()).toBe(globalPaths(dir).keysFile);
  });

  it("rejects a bad env var name or an empty value", () => {
    const store = createFileSecretStore({ dir: tmp() });
    expect(() => store.set("1BAD", "x")).toThrow(/invalid env var name/);
    expect(() => store.set("OK", "")).toThrow(/empty key value/);
  });

  it("reports a parse error (and empty values) for a corrupt keys.json", () => {
    const dir = tmp();
    seedFile(globalPaths(dir).keysFile, "{ not json");
    const snap = createFileSecretStore({ dir }).read();
    expect(snap.values).toEqual({});
    expect(snap.error).toContain("invalid JSON");
  });

  it("summarizes the first schema issue in a syntactically valid keys file", () => {
    const dir = tmp();
    seedFile(globalPaths(dir).keysFile, JSON.stringify({ "1BAD": "value" }));
    const snap = createFileSecretStore({ dir }).read();
    expect(snap.values).toEqual({});
    expect(snap.error).toContain("1BAD");
  });

  it("SecretService lists names only (never values)", async () => {
    const dir = tmp();
    const store = createFileSecretStore({ dir });
    const svc = createSecretService(store);
    await svc.set("ANTHROPIC_API_KEY", "sk-secret");
    expect(await svc.listNames()).toEqual(["ANTHROPIC_API_KEY"]);
    await svc.delete("ANTHROPIC_API_KEY");
    expect(await svc.listNames()).toEqual([]);
  });
});
