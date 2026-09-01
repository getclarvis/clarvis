import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePluginManifest, readPluginAgentFiles } from "../../src/settings/plugin-agents.ts";
import {
  PLUGIN_RESOURCE_LIMITS,
  readBoundedPluginText,
} from "../../src/settings/plugin-resources.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function agentsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "clarvis-plugin-agents-"));
  roots.push(root);
  return root;
}

describe("readPluginAgentFiles resource boundary", () => {
  it("treats a missing agents directory as an empty surface", () => {
    const root = agentsRoot();
    expect(readPluginAgentFiles(join(root, "missing"))).toEqual({ ok: true, files: [] });
  });

  it("reports a missing bounded plugin document without throwing", () => {
    const root = agentsRoot();
    expect(readBoundedPluginText(join(root, "missing.json"), 100, "plugin document")).toMatchObject(
      {
        ok: false,
        missing: true,
      },
    );
  });

  it("reads nested markdown deterministically and ignores non-agent files", () => {
    const root = agentsRoot();
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "z.md"), "z");
    writeFileSync(join(root, "nested", "a.md"), "a");
    writeFileSync(join(root, "ignored.txt"), "ignored");

    expect(readPluginAgentFiles(root)).toEqual({
      ok: true,
      files: [
        { name: "nested/a.md", content: "a" },
        { name: "z.md", content: "z" },
      ],
    });
  });

  it("rejects a sparse agent file before allocating its declared size", () => {
    const root = agentsRoot();
    const file = join(root, "sparse.md");
    writeFileSync(file, "x");
    truncateSync(file, PLUGIN_RESOURCE_LIMITS.agentFileBytes + 1);

    const result = readPluginAgentFiles(root);
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.error).toContain("resource limit");
  });

  it("rejects too many files as one atomic surface", () => {
    const root = agentsRoot();
    for (let index = 0; index <= PLUGIN_RESOURCE_LIMITS.agentFiles; index += 1) {
      writeFileSync(join(root, `${String(index).padStart(4, "0")}.md`), "x");
    }

    const result = readPluginAgentFiles(root);
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.error).toContain("file count");
  });

  it("rejects aggregate agent bytes even when every individual file fits", () => {
    const root = agentsRoot();
    const body = Buffer.alloc(PLUGIN_RESOURCE_LIMITS.agentFileBytes, 0x61);
    const files = Math.floor(
      PLUGIN_RESOURCE_LIMITS.agentAggregateBytes / PLUGIN_RESOURCE_LIMITS.agentFileBytes,
    );
    for (let index = 0; index <= files; index += 1) {
      writeFileSync(join(root, `${String(index).padStart(3, "0")}.md`), body);
    }

    const result = readPluginAgentFiles(root);
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.error).toContain("aggregate source");
  });

  it("rejects too many traversed directories even when they are empty", () => {
    const root = agentsRoot();
    for (let index = 0; index < PLUGIN_RESOURCE_LIMITS.agentDirectories; index += 1) {
      mkdirSync(join(root, `d-${String(index)}`));
    }

    const result = readPluginAgentFiles(root);
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.error).toContain("directory count");
  });

  it("rejects a directory deeper than the traversal budget", () => {
    const root = agentsRoot();
    let current = root;
    for (let depth = 0; depth <= PLUGIN_RESOURCE_LIMITS.agentDepth; depth += 1) {
      current = join(current, `d${String(depth)}`);
      mkdirSync(current);
    }
    writeFileSync(join(current, "agent.md"), "x");

    const result = readPluginAgentFiles(root);
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.error).toContain("depth");
  });
});

describe("parsePluginManifest resource boundary", () => {
  it("rejects a manifest before parsing when its UTF-8 payload exceeds the byte budget", () => {
    const result = parsePluginManifest("x".repeat(PLUGIN_RESOURCE_LIMITS.manifestBytes + 1));

    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.kind).toBe("resource");
      expect(result.error).toBeInstanceOf(Error);
      expect(String(result.error)).toContain("resource limit");
    }
  });

  it("distinguishes malformed JSON from a schema-invalid document", () => {
    const malformed = parsePluginManifest("{");
    expect(malformed.ok).toBeFalse();
    if (!malformed.ok) expect(malformed.kind).toBe("json");

    const invalid = parsePluginManifest("{}");
    expect(invalid.ok).toBeFalse();
    if (!invalid.ok) expect(invalid.kind).toBe("schema");
  });

  it("returns the normalized manifest after both boundaries accept it", () => {
    expect(parsePluginManifest('{"name":"bounded-plugin","author":{"name":"Clarvis"}}')).toEqual({
      ok: true,
      manifest: { name: "bounded-plugin", author: { name: "Clarvis" } },
    });
  });
});
