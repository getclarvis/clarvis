import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginManifest } from "@clarvis/loop/host";
import { snapshotPluginExecutables } from "../../src/plugins/plugin-executable-snapshot.ts";

describe("plugin executable snapshot", () => {
  let root: string;
  let plugin: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clarvis-plugin-executables-"));
    plugin = join(root, "plugin");
    mkdirSync(plugin);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("pins package-local MCP argv and hook files by content and mode", () => {
    const program = join(plugin, "server.sh");
    const argument = join(plugin, "config.json");
    writeFileSync(program, "#!/bin/sh\nexit 0\n");
    writeFileSync(argument, '{"version":1}\n');
    if (process.platform !== "win32") chmodSync(program, 0o700);
    const manifest = {
      name: "fixture",
      mcpServers: {
        local: { type: "stdio", command: "./server.sh", args: ["./config.json"], cwd: plugin },
      },
      hooks: [{ event: "run_start", command: program }],
    } as PluginManifest;

    const first = snapshotPluginExecutables(plugin, manifest);
    expect(first.ok).toBeTrue();
    if (!first.ok) throw new Error(first.error);
    expect(first.files.map((file) => file.path)).toEqual(["config.json", "server.sh"]);
    if (process.platform !== "win32") expect(first.files[1]!.mode).toBe(0o700);

    writeFileSync(argument, '{"version":2}\n');
    const changed = snapshotPluginExecutables(plugin, manifest);
    expect(changed.ok).toBeTrue();
    if (!changed.ok) throw new Error(changed.error);
    expect(changed.files[0]!.digest).not.toBe(first.files[0]!.digest);
    expect(changed.files[1]!.digest).toBe(first.files[1]!.digest);
  });

  it("rejects missing argv and captures a linked external executable", () => {
    const missing = snapshotPluginExecutables(plugin, {
      name: "fixture",
      mcpServers: { local: { type: "stdio", command: "./missing.sh", cwd: plugin } },
    } as PluginManifest);
    expect(missing).toMatchObject({ ok: false });

    if (process.platform !== "win32") {
      const outside = join(root, "outside.sh");
      writeFileSync(outside, "#!/bin/sh\n");
      symlinkSync(outside, join(plugin, "linked.sh"));
      expect(
        snapshotPluginExecutables(plugin, {
          name: "fixture",
          mcpServers: { local: { type: "stdio", command: "./linked.sh", cwd: plugin } },
        } as PluginManifest),
      ).toMatchObject({ ok: true, files: [{ path: "linked.sh" }] });
    }
  });

  it("rejects a package-local process file over the resource bound", () => {
    const program = join(plugin, "oversized.sh");
    writeFileSync(program, Buffer.alloc(8 * 1024 * 1024 + 1));
    const result = snapshotPluginExecutables(plugin, {
      name: "fixture",
      hooks: [{ event: "run_start", command: program }],
    } as PluginManifest);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("expected resource rejection");
    expect(result.error).toContain("resource limit");
  });

  it("bounds the number and aggregate bytes of referenced files", () => {
    const many: Record<string, { type: "stdio"; command: string; cwd: string }> = {};
    for (let index = 0; index <= 256; index += 1) {
      const name = `server-${String(index)}`;
      writeFileSync(join(plugin, name), "x");
      many[name] = { type: "stdio", command: `./${name}`, cwd: plugin };
    }
    const count = snapshotPluginExecutables(plugin, {
      name: "fixture",
      mcpServers: many,
    } as PluginManifest);
    expect(count).toMatchObject({ ok: false });
    if (count.ok) throw new Error("expected file-count rejection");
    expect(count.error).toContain("file resource limit");

    const large: Record<string, { type: "stdio"; command: string; cwd: string }> = {};
    for (let index = 0; index < 5; index += 1) {
      const name = `large-${String(index)}`;
      writeFileSync(join(plugin, name), Buffer.alloc(7 * 1024 * 1024));
      large[name] = { type: "stdio", command: `./${name}`, cwd: plugin };
    }
    const aggregate = snapshotPluginExecutables(plugin, {
      name: "fixture",
      mcpServers: large,
    } as PluginManifest);
    expect(aggregate).toMatchObject({ ok: false });
    if (aggregate.ok) throw new Error("expected aggregate-size rejection");
    expect(aggregate.error).toContain("aggregate limit");
  });

  it("reports a vanished plugin root before resolving any process file", () => {
    rmSync(plugin, { recursive: true });
    expect(snapshotPluginExecutables(plugin, { name: "fixture" } as PluginManifest)).toMatchObject({
      ok: false,
      error: expect.stringContaining("plugin root could not be resolved"),
    });
  });
});
