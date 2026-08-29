import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_RESOURCE_LIMITS } from "@clarvis/loop/host";
import {
  PLUGIN_INSTALL_RECORD,
  readPluginInstallRecord,
} from "../../src/plugins/plugin-install-record.ts";
import { createFilePluginRepository } from "../../src/adapters/filesystem/plugin-repository.ts";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "clarvis-plugin-record-"));
  roots.push(root);
  return root;
}

function writeRecord(dir: string, value: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PLUGIN_INSTALL_RECORD), value);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("plugin installation records", () => {
  it("bounds install metadata and exercises repository replacement and removal failures", async () => {
    const globalDir = fixture();
    const repository = createFilePluginRepository({ globalDir });
    const oversized = fixture();
    await expect(
      repository.install(oversized, "oversized", "clarvis", {
        root: oversized,
        origin: "x".repeat(PLUGIN_RESOURCE_LIMITS.installRecordBytes),
        dispose: () => {},
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    const replacement = fixture();
    const missing = { scope: "global" as const, source: "clarvis" as const, name: "missing" };
    await expect(repository.replace(replacement, missing, undefined)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await repository.remove(missing)).toBe(false);
    const workspaceRef = {
      scope: "workspace" as const,
      source: "clarvis" as const,
      name: "workspace-plugin",
    };
    await expect(repository.replace(fixture(), workspaceRef, undefined)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(repository.remove(workspaceRef)).rejects.toMatchObject({
      code: "invalid_request",
    });

    const installed = fixture();
    mkdirSync(join(installed, ".codex-plugin"), { recursive: true });
    writeFileSync(
      join(installed, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "removable", version: "1.0.0" }),
    );
    await repository.install(installed, "removable", "clarvis", undefined);
    expect(await repository.remove({ scope: "global", source: "clarvis", name: "removable" })).toBe(
      true,
    );
  });

  it("distinguishes an unmanaged plugin from an unreadable bounded record", () => {
    const dir = fixture();
    expect(readPluginInstallRecord(dir)).toEqual({ ok: true, record: {}, present: false });

    writeRecord(dir, "x");
    truncateSync(join(dir, PLUGIN_INSTALL_RECORD), PLUGIN_RESOURCE_LIMITS.installRecordBytes + 1);
    expect(readPluginInstallRecord(dir)).toMatchObject({
      ok: false,
      error: expect.stringContaining("exceeds"),
    });
  });

  it("rejects malformed JSON and JSON values that are not objects", () => {
    for (const value of ["{", "null", "[]"]) {
      const dir = fixture();
      writeRecord(dir, value);
      expect(readPluginInstallRecord(dir)).toMatchObject({ ok: false });
    }
    expect(readPluginInstallRecord(roots[0]!)).toMatchObject({
      error: expect.stringContaining("not valid JSON"),
    });
    expect(readPluginInstallRecord(roots[1]!)).toMatchObject({
      error: expect.stringContaining("must be an object"),
    });
  });

  it("validates every optional metadata field before admitting the record", () => {
    for (const field of ["source", "revision", "subdir"] as const) {
      const dir = fixture();
      writeRecord(dir, JSON.stringify({ [field]: 42 }));
      expect(readPluginInstallRecord(dir)).toMatchObject({
        ok: false,
        error: expect.stringContaining(`field '${field}' must be a string`),
      });
    }
  });
});
