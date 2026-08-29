import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  pluginSkillRoots,
  readPluginManifestSource,
  resolvePluginManifest,
} from "../../src/plugins/plugin-manifest.ts";
import { convertHooksDocument } from "../../src/plugins/hook-dialects.ts";
import { mcpServerPluginSchema, mcpServerSettingsSchema } from "@clarvis/loop/host";
import { PLUGIN_RESOURCE_LIMITS } from "@clarvis/loop/host";
import { EXTERNAL_HOOK_EVENT_NAMES, hookSchema, MAX_HOOK_TIMEOUT_MS } from "@clarvis/capability";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clarvis-manifest-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, body: unknown): void {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
}

const base = { name: "demo", version: "1.0.0", description: "A demo plugin." };
const AGENT_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const AGENT_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

function hookFingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/** Resolve the manifest the way both kernel readers do. */
function resolve(): ReturnType<typeof resolvePluginManifest> {
  const source = readPluginManifestSource(root);
  if (!("raw" in source)) throw new Error(source.error);
  return resolvePluginManifest(root, source.raw, source.location);
}

/** Resolve a portable Agent Plugin with the client-managed runtime data directory. */
function resolveAgentPlugin(dataDir: string): ReturnType<typeof resolvePluginManifest> {
  const source = readPluginManifestSource(root);
  if (!("raw" in source)) throw new Error(source.error);
  return resolvePluginManifest(root, source.raw, source.location, "portable.plugin", { dataDir });
}

/** The location a manifest was read from, or undefined when none was found. */
function locationRead(): string | undefined {
  const source = readPluginManifestSource(root);
  return "location" in source ? source.location : undefined;
}

/** Resolve the manifest of a plugin directory other than the scratch root. */
function resolveIn(dir: string): ReturnType<typeof resolvePluginManifest> {
  const source = readPluginManifestSource(dir);
  if (!("raw" in source)) throw new Error(source.error);
  return resolvePluginManifest(dir, source.raw, source.location);
}

/** Copy a committed fixture tree in as a plugin installed under `as`. */
function installFixture(name: string, as: string): string {
  const dir = join(root, as);
  cpSync(join(import.meta.dir, "..", "fixtures", name), dir, { recursive: true });
  return dir;
}

describe("manifest location", () => {
  it("reads the repository root first", () => {
    write("plugin.json", { ...base, description: "root" });
    write(".alpha-plugin/plugin.json", { ...base, description: "another host" });
    expect(locationRead()).toBe("plugin.json");
    expect(resolve().manifest?.description).toBe("root");
  });

  it("prefers our own dot-directory over a borrowed one", () => {
    write(".clarvis-plugin/plugin.json", { ...base, description: "ours" });
    write(".alpha-plugin/plugin.json", { ...base, description: "theirs" });
    expect(resolve().manifest?.description).toBe("ours");
  });

  it("falls back to any other host's dot-directory, whatever it is named", () => {
    write(".beta-plugin/plugin.json", { ...base, description: "a borrowed manifest" });
    expect(locationRead()).toBe(".beta-plugin/plugin.json");
    expect(resolve().manifest?.description).toBe("a borrowed manifest");
  });

  it("orders two borrowed manifests by name, so the choice is deterministic", () => {
    write(".beta-plugin/plugin.json", { ...base, description: "beta" });
    write(".alpha-plugin/plugin.json", { ...base, description: "alpha" });
    expect(locationRead()).toBe(".alpha-plugin/plugin.json");
  });

  it("selects the borrowed manifest that declares the richest compatible surface", () => {
    write(".alpha-plugin/plugin.json", { ...base, skills: "../skills" });
    write(".beta-plugin/plugin.json", {
      ...base,
      skills: "../skills",
      mcpServers: "../.mcp.json",
      hooks: "../hooks/hooks.json",
    });
    expect(locationRead()).toBe(".beta-plugin/plugin.json");
  });

  it("looks past a generic root identity manifest to a host manifest with contributions", () => {
    write("plugin.json", { ...base, extensions: { "some.host": {} } });
    write(".codex-plugin/plugin.json", {
      ...base,
      skills: "../skills",
      mcpServers: "../.mcp.json",
    });
    expect(locationRead()).toBe(".codex-plugin/plugin.json");
  });

  it("treats the Clarvis-specific manifest as authoritative", () => {
    write("plugin.json", { ...base, skills: "./skills", mcpServers: "./.mcp.json" });
    write(".clarvis-plugin/plugin.json", { ...base, description: "explicitly for Clarvis" });
    expect(locationRead()).toBe(".clarvis-plugin/plugin.json");
  });

  it("does not let an unusable root hide a readable Clarvis-specific manifest", () => {
    write("plugin.json", base);
    truncateSync(join(root, "plugin.json"), PLUGIN_RESOURCE_LIMITS.manifestBytes + 1);
    write(".clarvis-plugin/plugin.json", { ...base, description: "explicitly for Clarvis" });
    expect(locationRead()).toBe(".clarvis-plugin/plugin.json");
  });

  it("names every location it looked in when there is none", () => {
    expect(locationRead()).toBeUndefined();
    const source = readPluginManifestSource(root);
    expect("error" in source && source.error).toContain(".clarvis-plugin/plugin.json");
  });

  it("ignores a dot-directory that is not shaped like a host's", () => {
    write(".github/plugin.json", { ...base, description: "not a manifest dir" });
    expect(locationRead()).toBeUndefined();
  });

  it("rejects a sparse manifest before parsing or allocating its declared size", () => {
    write("plugin.json", base);
    truncateSync(join(root, "plugin.json"), PLUGIN_RESOURCE_LIMITS.manifestBytes + 1);
    const source = readPluginManifestSource(root);
    expect("error" in source && source.error).toContain("resource limit");
  });

  it("bounds borrowed-manifest discovery in a directory with too many entries", () => {
    for (let index = 0; index <= PLUGIN_RESOURCE_LIMITS.manifestLocationEntries; index += 1) {
      write(`entry-${String(index)}`, "x");
    }
    const source = readPluginManifestSource(root);
    expect("error" in source && source.error).toContain("manifest-discovery resource limit");
  });
});

describe("Agent Plugins v1 package", () => {
  it("loads the fixed skills tree and normalizes portable stdio and streamable HTTP servers", () => {
    const data = join(root, "runtime-data");
    mkdirSync(join(data, "work"), { recursive: true });
    write("plugin.json", {
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "portable.plugin",
      version: "2026.08-preview",
      description: "Portable package",
      skills: "./not-the-fixed-location",
      future_field: true,
    });
    write(
      "skills/research/SKILL.md",
      "---\nname: research\ndescription: Research instructions.\n---\n",
    );
    write("bin/server", "#!/bin/sh\n");
    write("mcp.json", {
      $schema: AGENT_MCP_SCHEMA,
      mcpServers: {
        local: {
          type: "stdio",
          command: "./bin/server",
          args: ["--root", "${PLUGIN_ROOT}/config", "${PLUGIN_DATA}/db"],
          env: { CACHE: "${PLUGIN_DATA}/cache", PACKAGE: "${PLUGIN_ROOT}" },
          cwd: "${PLUGIN_DATA}/work",
        },
        bare: { type: "stdio", command: "node" },
        web: {
          type: "streamable-http",
          url: "https://plugins.example.test/mcp",
          headers: { "X-Plugin": "portable" },
        },
        escaped: { type: "stdio", command: "../outside" },
      },
    });

    const { manifest, error, notes } = resolveAgentPlugin(data);
    const realRoot = realpathSync(root);
    const realData = realpathSync(data);

    expect(error).toBeUndefined();
    expect(manifest).toMatchObject({
      name: "portable.plugin",
      version: "2026.08-preview",
      skills: [join(realRoot, "skills")],
      mcpServers: {
        local: {
          type: "stdio",
          command: join(realRoot, "bin", "server"),
          args: ["--root", `${realRoot}/config`, `${realData}/db`],
          env: {
            CACHE: `${realData}/cache`,
            PACKAGE: realRoot,
            PLUGIN_ROOT: realRoot,
            PLUGIN_DATA: realData,
          },
          cwd: join(realData, "work"),
          expandVariables: false,
        },
        bare: {
          type: "stdio",
          command: "node",
          env: { PLUGIN_ROOT: realRoot, PLUGIN_DATA: realData },
          cwd: realRoot,
          expandVariables: false,
        },
        web: {
          type: "http",
          url: "https://plugins.example.test/mcp",
          headers: { "X-Plugin": "portable" },
          expandVariables: false,
        },
      },
    });
    expect(manifest?.mcpServers?.escaped).toBeUndefined();
    expect(notes.join(" ")).toContain("field 'future_field' is unknown and was ignored");
    expect(notes.join(" ")).toContain("field 'skills' is unknown and was ignored");
    expect(notes.join(" ")).toContain("'escaped' is not contributed");
  });

  it("keeps the plugin and its skills when the top-level MCP document is invalid", () => {
    const data = join(root, "runtime-data");
    mkdirSync(data, { recursive: true });
    write("plugin.json", {
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "portable.plugin",
    });
    write(
      "skills/research/SKILL.md",
      "---\nname: research\ndescription: Research instructions.\n---\n",
    );
    write("mcp.json", {
      $schema: AGENT_MCP_SCHEMA,
      mcpServers: { would_run: { type: "stdio", command: "node" } },
      unexpected: true,
    });

    const { manifest, error, notes } = resolveAgentPlugin(data);

    expect(error).toBeUndefined();
    expect(manifest?.skills).toEqual([join(realpathSync(root), "skills")]);
    expect(manifest?.mcpServers).toBeUndefined();
    expect(notes.join(" ")).toContain("MCP is disabled for this plugin");
  });

  it("drops only a portable MCP entry that exceeds a Clarvis host bound", () => {
    const data = join(root, "runtime-data");
    mkdirSync(data, { recursive: true });
    write("plugin.json", {
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "portable.plugin",
    });
    write(
      "skills/research/SKILL.md",
      "---\nname: research\ndescription: Research instructions.\n---\n",
    );
    write("mcp.json", {
      $schema: AGENT_MCP_SCHEMA,
      mcpServers: {
        good: { type: "stdio", command: "node" },
        oversized: { type: "stdio", command: "x".repeat(8193) },
      },
    });

    const { manifest, error, notes } = resolveAgentPlugin(data);

    expect(error).toBeUndefined();
    expect(manifest?.skills).toEqual([join(realpathSync(root), "skills")]);
    expect(Object.keys(manifest?.mcpServers ?? {})).toEqual(["good"]);
    expect(notes.join(" ")).toContain("'oversized' is not contributed");
  });

  it("rejects an unsupported portable manifest schema instead of guessing", () => {
    write("plugin.json", {
      $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
      name: "portable.plugin",
    });
    const source = readPluginManifestSource(root);
    if (!("raw" in source)) throw new Error(source.error);

    expect(resolvePluginManifest(root, source.raw, source.location).error).toContain(
      "unsupported Agent Plugins manifest schema",
    );
  });

  it("treats a root portable manifest as authoritative over a host-specific manifest", () => {
    write("plugin.json", {
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "portable.plugin",
      description: "portable root",
    });
    write(".codex-plugin/plugin.json", {
      name: "portable.plugin",
      description: "host-specific fallback",
      mcpServers: { hidden: { command: "would-run" } },
    });

    expect(locationRead()).toBe("plugin.json");
    expect(resolve().manifest).toMatchObject({
      name: "portable.plugin",
      description: "portable root",
    });
    expect(resolve().manifest?.mcpServers).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "rejects a portable manifest symlink that leaves the package",
    () => {
      const outside = mkdtempSync(join(tmpdir(), "clarvis-manifest-outside-"));
      try {
        writeFileSync(
          join(outside, "plugin.json"),
          JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "portable.plugin" }),
        );
        symlinkSync(join(outside, "plugin.json"), join(root, "plugin.json"));

        const source = readPluginManifestSource(root);
        expect("error" in source && source.error).toContain("resolves outside the plugin root");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "disables only MCP when root mcp.json leaves the package",
    () => {
      const outside = mkdtempSync(join(tmpdir(), "clarvis-mcp-outside-"));
      const data = join(root, "runtime-data");
      mkdirSync(data, { recursive: true });
      try {
        write("plugin.json", { $schema: AGENT_PLUGIN_SCHEMA, name: "portable.plugin" });
        writeFileSync(
          join(outside, "mcp.json"),
          JSON.stringify({
            $schema: AGENT_MCP_SCHEMA,
            mcpServers: { escaped: { type: "stdio", command: "node" } },
          }),
        );
        symlinkSync(join(outside, "mcp.json"), join(root, "mcp.json"));

        const { manifest, error, notes } = resolveAgentPlugin(data);
        expect(error).toBeUndefined();
        expect(manifest?.name).toBe("portable.plugin");
        expect(manifest?.mcpServers).toBeUndefined();
        expect(notes.join(" ")).toContain("resolves outside the plugin root");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );
});

describe("foreign manifest fields", () => {
  it("accepts an author object and keeps the name", () => {
    write("plugin.json", { ...base, author: { name: "Jesse", email: "j@example.com" } });
    expect(resolve().manifest?.author).toBe("Jesse");
  });

  it("installs on name alone", () => {
    write("plugin.json", { name: "demo" });
    const { manifest, error } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.name).toBe("demo");
    expect(manifest?.version).toBeUndefined();
  });

  it("reports 'dependencies' rather than validating it into silence", () => {
    write("plugin.json", { ...base, dependencies: ["other-plugin"] });
    const { manifest, notes, error } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.name).toBe(base.name);
    expect(notes.join(" ")).toContain("does not act on: dependencies");
    expect(notes.join(" ")).not.toContain("did you mean");
  });

  it("names a misspelled key as a misspelling, ahead of the merely foreign ones", () => {
    write("plugin.json", { ...base, mcpServer: {}, license: "MIT" });
    const { notes } = resolve();
    expect(notes[0]).toContain("did you mean 'mcpServers'?");
    expect(notes.join(" ")).toContain("does not act on: license");
    expect(notes.join(" ")).not.toContain("does not act on: license, mcpServer");
  });

  it("installs despite informational keys, and names them", () => {
    write("plugin.json", { ...base, license: "MIT", homepage: "https://example.com" });
    const { manifest, notes } = resolve();
    expect(manifest?.name).toBe("demo");
    expect(notes.join(" ")).toContain("homepage, license");
  });

  it("scans the skills location the manifest names, silently", () => {
    write("plugin.json", { ...base, skills: "./lib/skills/" });
    const { notes } = resolve();
    expect(notes.filter((n) => n.includes("skills"))).toEqual([]);
    expect(pluginSkillRoots(root, "./lib/skills/").roots).toEqual([join(root, "lib", "skills")]);
  });

  it("says nothing at all about a skills location that agrees with where it looks", () => {
    write("plugin.json", { ...base, skills: "./skills/" });
    expect(resolve().notes.filter((n) => n.includes("skills"))).toEqual([]);
  });

  it("reads the list form of skills as several roots", () => {
    write("plugin.json", { ...base, skills: ["./skills/", "./extra/"] });
    expect(resolve().notes.filter((n) => n.includes("skills"))).toEqual([]);
    expect(pluginSkillRoots(root, ["./skills/", "./extra/"]).roots).toEqual([
      join(root, "skills"),
      join(root, "extra"),
    ]);
  });

  it("scans the default location when the manifest names none", () => {
    expect(pluginSkillRoots(root, undefined)).toEqual({ roots: [join(root, "skills")], notes: [] });
  });

  it("drops a skills location that climbs out of the plugin, keeping the rest", () => {
    const { roots, notes } = pluginSkillRoots(root, ["../elsewhere", "./mine"]);
    expect(roots).toEqual([join(root, "mine")]);
    expect(notes.join(" ")).toContain("resolves outside the plugin");
  });

  it("falls back to the default when nothing declared can be scanned", () => {
    const { roots, notes } = pluginSkillRoots(root, ["../elsewhere"]);
    expect(roots).toEqual([join(root, "skills")]);
    expect(notes.join(" ")).toContain("nothing declared could be scanned");
  });

  it("reports a skills location naming a file rather than a directory of skills", () => {
    const { roots, notes } = pluginSkillRoots(root, "./SKILL.md");
    expect(roots).toEqual([join(root, "skills")]);
    expect(notes.join(" ")).toContain("names a file");
  });

  it("reports a skills declaration that is neither a path nor a list of them", () => {
    const { roots, notes } = pluginSkillRoots(root, 7);
    expect(roots).toEqual([join(root, "skills")]);
    expect(notes.join(" ")).toContain("not a path or a list of paths");
  });

  it("drops a non-string entry from a list of skills locations", () => {
    const { roots, notes } = pluginSkillRoots(root, ["./mine", 7, "  "]);
    expect(roots).toEqual([join(root, "mine")]);
    expect(notes.filter((n) => n.includes("is not a path"))).toHaveLength(2);
  });

  it("caps how many locations one plugin may contribute, and says it did", () => {
    const declared = ["./a", "./b", "./c", "./d", "./e", "./f"];
    const { roots, notes } = pluginSkillRoots(root, declared);
    expect(roots).toHaveLength(4);
    expect(roots).toEqual(["a", "b", "c", "d"].map((d) => join(root, d)));
    expect(notes.join(" ")).toContain("only the first 4 of 6");
  });

  it("compacts exhaustive direct-skill siblings before applying the root budget", () => {
    const declared = [
      "./skills/engineering/alpha",
      "./skills/engineering/beta",
      "./skills/engineering/gamma",
      "./skills/productivity/delta",
      "./skills/productivity/epsilon",
      "./skills/productivity/zeta",
    ];
    for (const skill of declared) write(`${skill}/SKILL.md`, "skill");

    expect(pluginSkillRoots(root, declared)).toEqual({
      roots: [join(root, "skills", "engineering"), join(root, "skills", "productivity")],
      notes: [],
    });
  });

  it("does not compact a group when that would admit an undeclared sibling", () => {
    const declared = ["alpha", "beta", "gamma", "delta", "epsilon"].map(
      (skill) => `./skills/${skill}`,
    );
    for (const skill of [...declared, "./skills/private"]) write(`${skill}/SKILL.md`, "skill");

    const { roots, notes } = pluginSkillRoots(root, declared);
    expect(roots).toEqual(
      ["alpha", "beta", "gamma", "delta"].map((skill) => join(root, "skills", skill)),
    );
    expect(notes.join(" ")).toContain("only the first 4 of 5 effective locations");
  });

  it("de-duplicates two declarations that name the same directory", () => {
    expect(pluginSkillRoots(root, ["./mine", "mine/"]).roots).toEqual([join(root, "mine")]);
  });

  it("reports a manifest that exists but cannot be read, rather than looking past it", () => {
    mkdirSync(join(root, "plugin.json"), { recursive: true });
    const source = readPluginManifestSource(root);
    expect("error" in source && source.error).toContain("not a regular file");
  });
});

describe("mcpServers named as a companion document", () => {
  const companion = { mcpServers: { charts: { command: "atlas-mcp", args: ["--stdio"] } } };

  it("reads the map out of the document the manifest names", () => {
    write("plugin.json", { ...base, mcpServers: "./.mcp.json" });
    write(".mcp.json", companion);
    const { manifest, error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.mcpServers?.charts?.command).toBe("atlas-mcp");
    expect(notes.join(" ")).not.toContain("mcpServers");
  });

  it("discovers .mcp.json by convention when the selected manifest names no document", () => {
    write("plugin.json", base);
    write(".mcp.json", companion);
    const { manifest, error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.mcpServers?.charts?.command).toBe("atlas-mcp");
    expect(notes.join(" ")).not.toContain("mcpServers");
  });

  it("falls back from an absent .mcp.json to mcp.json", () => {
    write("plugin.json", base);
    write("mcp.json", companion);
    expect(resolve().manifest?.mcpServers?.charts?.command).toBe("atlas-mcp");
  });

  it("keeps a malformed conventional file proportional and tries the next convention", () => {
    write("plugin.json", base);
    write(".mcp.json", "{nope");
    write("mcp.json", companion);
    const { manifest, notes, error } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.mcpServers?.charts?.command).toBe("atlas-mcp");
    expect(notes.join(" ")).toContain(".mcp.json");
  });

  it("resolves the path against the plugin root, not the manifest's own directory", () => {
    write(".alpha-plugin/plugin.json", { ...base, mcpServers: "./.mcp.json" });
    write(".mcp.json", companion);
    expect(resolve().manifest?.mcpServers?.charts?.command).toBe("atlas-mcp");
  });

  it("keeps an inline map exactly as it was written", () => {
    write("plugin.json", { ...base, mcpServers: companion.mcpServers });
    const { manifest, notes } = resolve();
    expect(manifest?.mcpServers?.charts?.args).toEqual(["--stdio"]);
    expect(notes).toEqual([]);
  });

  it("installs the plugin and withholds the servers when the document is missing", () => {
    write("plugin.json", { ...base, mcpServers: "./.mcp.json" });
    const { manifest, error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.name).toBe("demo");
    expect(manifest?.mcpServers).toBeUndefined();
    expect(notes.join(" ")).toContain(".mcp.json");
    expect(notes.join(" ")).toContain("no MCP servers are contributed");
  });

  it("degrades a malformed companion without taking the plugin down", () => {
    write("plugin.json", { ...base, mcpServers: "./.mcp.json" });
    write(".mcp.json", "{nope");
    const { manifest, error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.name).toBe("demo");
    expect(manifest?.mcpServers).toBeUndefined();
    expect(notes.join(" ")).toContain("is not valid JSON");
  });

  it("degrades a companion that carries no server map", () => {
    write("plugin.json", { ...base, mcpServers: "./.mcp.json" });
    write(".mcp.json", { servers: {} });
    const { error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(notes.join(" ")).toContain("declares no 'mcpServers' object");
  });

  it("degrades a companion that is not a JSON object at all", () => {
    write("plugin.json", { ...base, mcpServers: "./.mcp.json" });
    write(".mcp.json", [1, 2, 3]);
    expect(resolve().notes.join(" ")).toContain("does not hold a JSON object");
  });

  it("applies the manifest byte ceiling to the companion, and still loads the plugin", () => {
    write("plugin.json", { ...base, mcpServers: "./.mcp.json" });
    write(".mcp.json", "{}");
    truncateSync(join(root, ".mcp.json"), PLUGIN_RESOURCE_LIMITS.manifestBytes + 1);
    const { manifest, error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.name).toBe("demo");
    expect(notes.join(" ")).toContain("resource limit");
  });

  it("says so when the declaration names no document", () => {
    write("plugin.json", { ...base, mcpServers: "   " });
    const { error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(notes.join(" ")).toContain("names no document");
  });
});

describe("combined external plugin layout", () => {
  it("keeps skills, conventional MCP servers, and translated hooks together", () => {
    write("plugin.json", { ...base, extensions: { "generic.host": {} } });
    write(".example-plugin/plugin.json", {
      ...base,
      skills: "../skills",
      hooks: "../hooks/hooks.json",
    });
    write("skills/example/SKILL.md", "---\nname: example\ndescription: Example skill.\n---\n");
    write(".mcp.json", {
      mcpServers: { charts: { command: "atlas-mcp", args: ["--stdio"] } },
    });
    write("hooks/hooks.json", {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash|Skill|mcp__charts__render",
            hooks: [{ type: "command", command: "guard" }],
          },
        ],
      },
    });

    const source = readPluginManifestSource(root);
    if (!("raw" in source)) throw new Error(source.error);
    const { manifest, error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(source.location).toBe(".example-plugin/plugin.json");
    expect(pluginSkillRoots(root, "../skills", source.location)).toEqual({
      roots: [join(root, "skills")],
      notes: [],
    });
    expect(manifest?.mcpServers?.charts?.command).toBe("atlas-mcp");
    expect(manifest?.hooks).toEqual([
      {
        event: "pre_tool_use",
        command: "guard",
        match: { tool: ["shell", "load_skill", "demo:charts.render"] },
      },
    ]);
    expect(notes).toEqual([]);
  });
});

describe("presentation metadata and keys with no equivalent here", () => {
  const block = {
    displayName: "Atlas Tools",
    shortDescription: "Charts and maps for a workspace.",
    icon: "./assets/atlas.svg",
  };

  it("reads a display name and a short description, and stops calling the key unacted on", () => {
    write("plugin.json", { ...base, interface: block });
    const { presentation, notes, error } = resolve();
    expect(error).toBeUndefined();
    expect(presentation).toEqual({
      displayName: "Atlas Tools",
      shortDescription: "Charts and maps for a workspace.",
    });
    expect(notes.join(" ")).not.toContain("interface");
  });

  it("keeps a connector key unacted on, and never an error", () => {
    write("plugin.json", { ...base, apps: [{ id: "atlas-board", kind: "connector" }] });
    const { manifest, error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.name).toBe("demo");
    expect(notes.join(" ")).toContain("does not act on: apps");
  });

  it("does not mistake a connector key for a misspelling of one it knows", () => {
    write("plugin.json", { ...base, apps: [] });
    expect(resolve().notes.join(" ")).not.toContain("did you mean");
  });

  it("notes a presentation block it cannot read, and loads the plugin anyway", () => {
    write("plugin.json", { ...base, interface: "Atlas Tools" });
    const { manifest, error, presentation, notes } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.name).toBe("demo");
    expect(presentation).toBeUndefined();
    expect(notes.join(" ")).toContain("nothing was read from it");
  });

  it("notes a presentation block that carries nothing to show", () => {
    write("plugin.json", { ...base, interface: { icon: "./assets/atlas.svg" } });
    const { presentation, notes } = resolve();
    expect(presentation).toBeUndefined();
    expect(notes.join(" ")).toContain("no display name or short description");
  });

  it("ignores a blank display name rather than showing an empty row", () => {
    write("plugin.json", { ...base, interface: { displayName: "   ", shortDescription: "Maps." } });
    expect(resolve().presentation).toEqual({ shortDescription: "Maps." });
  });
});

describe("fields this host supplies rather than refusing over", () => {
  it("derives the name from the install directory and records that it did", () => {
    const dir = installFixture("foreign-plugin-sparse", "atlas");
    const { manifest, error, notes } = resolveIn(dir);
    expect(error).toBeUndefined();
    expect(manifest?.name).toBe("atlas");
    expect(notes.join(" ")).toContain("name: not declared");
    expect(notes.join(" ")).toContain("'atlas'");
  });

  it("uses the offered short description when the manifest declares none", () => {
    const dir = installFixture("foreign-plugin-sparse", "atlas");
    const { manifest, notes } = resolveIn(dir);
    expect(manifest?.description).toBe("Charts and maps for a workspace.");
    expect(notes.join(" ")).toContain("description: not declared");
  });

  it("supplies nothing the manifest already declares", () => {
    write("plugin.json", { ...base, interface: { shortDescription: "Maps." } });
    const { manifest, notes } = resolve();
    expect(manifest?.name).toBe("demo");
    expect(manifest?.description).toBe("A demo plugin.");
    expect(notes.join(" ")).not.toContain("not declared");
  });

  it("invents no description when there is none to move", () => {
    const dir = join(root, "atlas");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ version: "1.0.0" }));
    const { manifest, error } = resolveIn(dir);
    expect(error).toBeUndefined();
    expect(manifest?.name).toBe("atlas");
    expect(manifest?.description).toBeUndefined();
  });

  it("leaves the name to the schema when the directory could never be one", () => {
    const dir = join(root, ".staging-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ version: "1.0.0" }));
    const { manifest, error } = resolveIn(dir);
    expect(manifest).toBeUndefined();
    expect(error).toContain("name");
  });
});

describe("a committed manifest in another host's dialect", () => {
  it("resolves whole from a bare root plugin.json", () => {
    const dir = installFixture("foreign-plugin", "atlas");
    const source = readPluginManifestSource(dir);
    expect("location" in source && source.location).toBe("plugin.json");

    const { manifest, error, notes, presentation } = resolveIn(dir);
    expect(error).toBeUndefined();
    expect(manifest?.name).toBe("atlas");
    expect(manifest?.author).toBe("A. Author");
    expect(manifest?.mcpServers?.charts?.command).toBe("atlas-mcp");
    expect(presentation?.displayName).toBe("Atlas Tools");
    expect(notes.join(" ")).toContain("does not act on: apps, license");
  });

  it("resolves the same manifest from a shape-matched host directory", () => {
    const dir = installFixture("foreign-plugin-borrowed", "atlas");
    const source = readPluginManifestSource(dir);
    expect("location" in source && source.location).toBe(".alpha-plugin/plugin.json");

    const { manifest, error, presentation, notes } = resolveIn(dir);
    expect(error).toBeUndefined();
    expect(manifest?.name).toBe("atlas");
    expect(manifest?.mcpServers?.charts?.args).toEqual(["--stdio"]);
    expect(manifest?.description).toBe("Charts and maps for a workspace.");
    expect(presentation?.shortDescription).toBe("Charts and maps for a workspace.");
    expect(notes.join(" ")).toContain("does not act on: apps");
  });

  it("keeps a corrupted companion from taking the plugin down", () => {
    const dir = installFixture("foreign-plugin", "atlas");
    writeFileSync(join(dir, ".mcp.json"), "{nope");
    const { manifest, error, notes } = resolveIn(dir);
    expect(error).toBeUndefined();
    expect(manifest?.name).toBe("atlas");
    expect(manifest?.mcpServers).toBeUndefined();
    expect(notes.join(" ")).toContain("no MCP servers are contributed");
  });
});

describe("MCP server entries a manifest carries", () => {
  it("ignores a configuration key this host gives no meaning to", () => {
    write("plugin.json", {
      ...base,
      mcpServers: {
        atlas: { command: "atlas-mcp", cwd: "/somewhere", startup_timeout_sec: 30, note: "hi" },
      },
    });
    const { manifest, error } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.mcpServers?.atlas).toMatchObject({ command: "atlas-mcp" });
  });

  it("drops one unusable entry and keeps both the others and the plugin", () => {
    write("plugin.json", {
      ...base,
      mcpServers: {
        good: { command: "atlas-mcp" },
        headless: { type: "stdio" },
        alsoGood: { type: "http", url: "https://example.test/mcp" },
      },
    });
    const { manifest, error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(Object.keys(manifest?.mcpServers ?? {}).sort()).toEqual(["alsoGood", "good"]);
    expect(notes.join(" ")).toContain("'headless' is not contributed");
  });

  it("takes the key off entirely when no entry survives", () => {
    write("plugin.json", { ...base, mcpServers: { headless: { type: "stdio" } } });
    const { manifest, error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.mcpServers).toBeUndefined();
    expect(notes.join(" ")).toContain("'headless' is not contributed");
  });

  it("says nothing when every entry is usable", () => {
    write("plugin.json", { ...base, mcpServers: { atlas: { command: "atlas-mcp" } } });
    expect(resolve().notes.filter((n) => n.includes("not contributed"))).toEqual([]);
  });

  it("supports portable cwd while settings remain strict about unrelated keys", () => {
    expect(mcpServerSettingsSchema.safeParse({ command: "x", cwd: "/somewhere" }).success).toBe(
      true,
    );
    expect(mcpServerPluginSchema.safeParse({ command: "x", cwd: "/somewhere" }).success).toBe(true);
    expect(
      mcpServerSettingsSchema.safeParse({ command: "x", workingDirectory: "/somewhere" }).success,
    ).toBe(false);
    expect(
      mcpServerPluginSchema.safeParse({ command: "x", workingDirectory: "/somewhere" }).success,
    ).toBe(true);
  });
});

describe("hooks written in the external dialect", () => {
  const sessionStart = {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|clear|compact",
          hooks: [
            { type: "command", command: '"${SOME_HOST_PLUGIN_ROOT}/hooks/go" session-start' },
          ],
        },
      ],
    },
  };

  it("picks up hooks/hooks.json by convention and resolves the plugin root", () => {
    write("plugin.json", base);
    write("hooks/hooks.json", sessionStart);
    const { manifest, notes } = resolve();
    expect(manifest?.hooks).toEqual([
      { event: "session_start", command: `"${join(root, "hooks/go")}" session-start` },
    ]);
    expect(notes.join(" ")).toContain("matcher 'startup|clear|compact' ignored");
  });

  describe("the plugin root, in every spelling a command writes it", () => {
    const command = (raw: string): string =>
      convertHooksDocument({ PreToolUse: [{ hooks: [{ command: raw }] }] }, "/opt/p").hooks[0]!
        .command;

    it("resolves the bare and braced forms", () => {
      expect(command("$PLUGIN_ROOT/go")).toBe("/opt/p/go");
      expect(command("${PLUGIN_ROOT}/go")).toBe("/opt/p/go");
      expect(command("${SOME_HOST_PLUGIN_ROOT}/go")).toBe("/opt/p/go");
    });

    it("resolves a reference wrapped in a default, which is the careful spelling", () => {
      expect(command("${PLUGIN_ROOT:-}/go")).toBe("/opt/p/go");
      expect(command("${PLUGIN_ROOT:-/fallback}/go")).toBe("/opt/p/go");
      expect(command("${PLUGIN_ROOT-/fallback}/go")).toBe("/opt/p/go");
      expect(command("${PLUGIN_ROOT:=/fallback}/go")).toBe("/opt/p/go");
      expect(command("${PLUGIN_ROOT:?unset}/go")).toBe("/opt/p/go");
    });

    it("resolves a root nested inside another variable's default", () => {
      expect(command("${OTHER_HOST_PLUGIN_ROOT:-${PLUGIN_ROOT}}/go")).toBe("/opt/p/go");
      expect(command("${NOT_A_ROOT:-${PLUGIN_ROOT}}/go")).toBe("${NOT_A_ROOT:-/opt/p}/go");
    });

    it("answers an alternate-value expansion with its alternate, not with the root", () => {
      expect(command("${PLUGIN_ROOT:+${PLUGIN_ROOT}/bin}")).toBe("/opt/p/bin");
    });

    it("leaves a string operation it cannot emulate exactly as written", () => {
      expect(command("${PLUGIN_ROOT#/opt}/go")).toBe("${PLUGIN_ROOT#/opt}/go");
    });

    it("does not eat a different variable whose name merely starts with one", () => {
      expect(command("$PLUGIN_ROOTS/x")).toBe("$PLUGIN_ROOTS/x");
      expect(command("$MY_PLUGIN_ROOT_DIR/x")).toBe("$MY_PLUGIN_ROOT_DIR/x");
      expect(command("$PLUGIN_ROOT/x")).toBe("/opt/p/x");
    });

    it("leaves anything that is not a plugin root alone", () => {
      expect(command("$HOME/go")).toBe("$HOME/go");
      expect(command("${HOME}/go")).toBe("${HOME}/go");
      expect(command("cost is $5")).toBe("cost is $5");
      expect(command("${unbalanced/go")).toBe("${unbalanced/go");
    });
  });

  describe("tool names, which the two dialects spell differently", () => {
    const match = (matcher: string): unknown =>
      convertHooksDocument({ PreToolUse: [{ matcher, hooks: [{ command: "c" }] }] }, "/opt/p")
        .hooks[0]?.match;

    it("maps the names a real filter reaches for", () => {
      expect(match("Bash|Edit|Write|MultiEdit")).toEqual({
        tool: ["shell", "edit_file", "write_file", "multi_edit"],
      });
    });

    it("maps a name that differs from ours only in case", () => {
      expect(match("Grep|Glob")).toEqual({ tool: ["grep", "glob"] });
    });

    it("carries through a name it has no opinion about", () => {
      expect(match("apply_patch|some_other_tool")).toEqual({
        tool: ["apply_patch", "some_other_tool"],
      });
    });

    it("rewrites the foreign MCP spelling into the dotted one this host dispatches", () => {
      expect(match("mcp__github__create_issue")).toEqual({ tool: ["github.create_issue"] });
      expect(match("mcp__github__.*")).toEqual({ tool: ["github.*"] });
      expect(match("mcp__github.*")).toEqual({ tool: ["github*"] });
      expect(match("mcp__plugin_.*cloud-core.*")).toEqual({ tool: ["cloud-core.*"] });
      expect(match("mcp__.*")).toEqual({ tool: ["*.*"] });
    });

    it("qualifies a plugin-owned MCP matcher with the effective plugin namespace", () => {
      const converted = convertHooksDocument(
        {
          PreToolUse: [
            {
              matcher: "mcp__docs__search|mcp__plugin_.*docs.*|mcp__outside__search",
              hooks: [{ command: "guard" }],
            },
          ],
        },
        "/plugins/quality-kit",
        { pluginName: "quality-kit", pluginMcpServers: ["docs"] },
      );
      expect(converted.hooks[0]?.match).toEqual({
        tool: ["quality-kit:docs.search", "quality-kit:docs.*", "outside.search"],
      });
      expect(converted.notes).toEqual([]);
    });

    it("uses the host-owned install identity when it differs from manifest presentation", () => {
      const dir = installFixture("foreign-plugin", "installed-name");
      writeFileSync(
        join(dir, "plugin.json"),
        JSON.stringify({
          ...base,
          name: "display-name",
          mcpServers: { docs: { command: "docs-server" } },
          hooks: {
            PreToolUse: [{ matcher: "mcp__docs__search", hooks: [{ command: "guard" }] }],
          },
        }),
      );
      const source = readPluginManifestSource(dir);
      if (!("raw" in source)) throw new Error(source.error);

      const resolved = resolvePluginManifest(dir, source.raw, source.location, "installed-name");

      expect(resolved.manifest?.hooks?.[0]?.match).toEqual({
        tool: ["installed-name:docs.search"],
      });
    });

    it("keeps usable alternatives when one regular-expression branch cannot translate", () => {
      const { hooks, notes } = convertHooksDocument(
        {
          PreToolUse: [
            {
              matcher: "use_service|mcp__cloud.*|Bash(?:guard)",
              hooks: [{ command: "protect" }],
            },
          ],
        },
        "/opt/p",
      );
      expect(hooks[0]?.match).toEqual({ tool: ["use_service", "cloud*"] });
      expect(notes.join(" ")).toContain("'Bash(?:guard)'");
      expect(notes.join(" ")).toContain("rest of the filter still applies");
    });

    it("refuses a malformed foreign MCP name instead of widening its filter", () => {
      const { hooks, notes } = convertHooksDocument(
        { PreToolUse: [{ matcher: "mcp__github__", hooks: [{ command: "c" }] }] },
        "/opt/p",
      );
      expect(hooks).toEqual([]);
      expect(notes.join(" ")).toContain("cannot express");
    });

    it("de-duplicates two spellings that land on the same tool", () => {
      expect(match("Edit|edit_file")).toEqual({ tool: ["edit_file"] });
    });

    it("drops a name with no counterpart and keeps the rest, saying which", () => {
      const { hooks, notes } = convertHooksDocument(
        { PreToolUse: [{ matcher: "Edit|ExitPlanMode", hooks: [{ command: "c" }] }] },
        "/opt/p",
      );
      expect(hooks[0]?.match).toEqual({ tool: ["edit_file"] });
      expect(notes.join(" ")).toContain("'ExitPlanMode'");
    });

    it("skips a group whose every name is one this host lacks, rather than widening it", () => {
      const { hooks, notes } = convertHooksDocument(
        { PreToolUse: [{ matcher: "ExitPlanMode|TodoWrite", hooks: [{ command: "c" }] }] },
        "/opt/p",
      );
      expect(hooks).toEqual([]);
      expect(notes.join(" ")).toContain("names no tool this host has");
    });

    it.each(["Bash(?:foo)", "Edit.*", "Write.*", "Notebook.*", "github.*", "Bash|.*"])(
      "refuses %p rather than reading it as a name: a glob cannot express it either way",
      (matcher) => {
        const { hooks, notes } = convertHooksDocument(
          { PreToolUse: [{ matcher, hooks: [{ command: "c" }] }] },
          "/opt/p",
        );
        expect(hooks).toEqual([]);
        expect(notes.join(" ")).toContain("carries regular-expression syntax");
      },
    );

    it.each(["^.*$", "*", ".*"])("reads the catch-all %p as no filter at all", (matcher) => {
      const { hooks, notes } = convertHooksDocument(
        { PreToolUse: [{ matcher, hooks: [{ command: "c" }] }] },
        "/opt/p",
      );
      expect(hooks).toHaveLength(1);
      expect(hooks[0]?.match).toBeUndefined();
      expect(notes).toEqual([]);
    });

    it("strips anchors before naming a tool", () => {
      expect(
        convertHooksDocument(
          { PreToolUse: [{ matcher: "^Bash$", hooks: [{ command: "c" }] }] },
          "/opt/p",
        ).hooks[0]?.match,
      ).toEqual({ tool: ["shell"] });
    });
  });

  it("follows a hooks path declared by the manifest", () => {
    write("plugin.json", { ...base, hooks: "./hooks/declared.json" });
    write("hooks/declared.json", sessionStart);
    expect(resolve().manifest?.hooks).toHaveLength(1);
  });

  it("accepts an event map inline, the form a manifest carries directly", () => {
    write("plugin.json", {
      ...base,
      hooks: { PreToolUse: [{ matcher: "shell", hooks: [{ command: "check" }] }] },
    });
    expect(resolve().manifest?.hooks).toEqual([
      { event: "pre_tool_use", command: "check", match: { tool: ["shell"] } },
    ]);
  });

  it("leaves an empty inline object contributing nothing when there is nothing else", () => {
    write("plugin.json", { ...base, hooks: {} });
    const { manifest, error } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.hooks).toBeUndefined();
  });

  describe("precedence — one source wins, the two are never merged", () => {
    const inline = { PostToolUse: [{ hooks: [{ command: "from-the-manifest" }] }] };

    it("prefers what the manifest declares over the convention file", () => {
      write("plugin.json", { ...base, hooks: inline });
      write("hooks/hooks.json", sessionStart);
      const { manifest, notes } = resolve();
      expect(manifest?.hooks).toEqual([{ event: "post_tool_use", command: "from-the-manifest" }]);
      expect(notes.join(" ")).toContain("not read — the manifest declares its own hooks");
    });

    it("falls through to the convention when the declaration names nothing", () => {
      write("plugin.json", { ...base, hooks: {} });
      write("hooks/hooks.json", sessionStart);
      const { manifest, notes } = resolve();
      expect(manifest?.hooks).toHaveLength(1);
      expect(manifest?.hooks?.[0]?.event).toBe("session_start");
      expect(notes.join(" ")).toContain("was read instead");
    });

    it("treats an empty native array the same way an empty map is treated", () => {
      write("plugin.json", { ...base, hooks: [] });
      write("hooks/hooks.json", sessionStart);
      expect(resolve().manifest?.hooks).toHaveLength(1);
    });

    it("says nothing about precedence when only one source exists", () => {
      write("plugin.json", { ...base, hooks: inline });
      const { notes } = resolve();
      expect(notes.join(" ")).not.toContain("precedence");
      expect(notes.join(" ")).not.toContain("read instead");
    });

    it("does not report the convention file as shadowed when it is the file named", () => {
      write("plugin.json", { ...base, hooks: "./hooks/hooks.json" });
      write("hooks/hooks.json", sessionStart);
      const { manifest, notes } = resolve();
      expect(manifest?.hooks).toHaveLength(1);
      expect(notes.join(" ")).not.toContain("not read");
    });
  });

  describe("documents that ornament the shape differently", () => {
    it("reads camelCase event names and bare command entries, with a versioned envelope", () => {
      write("plugin.json", { ...base, hooks: "./hooks/declared.json" });
      write("hooks/declared.json", {
        version: 1,
        hooks: { sessionStart: [{ command: "./hooks/go session-start" }] },
      });
      const { manifest, notes } = resolve();
      expect(manifest?.hooks).toEqual([
        { event: "session_start", command: `"${join(root, "hooks/go")}" session-start` },
      ]);
      expect(notes).toEqual([]);
    });

    it("matches an event name however the source host ornaments it", () => {
      for (const spelling of ["PreToolUse", "preToolUse", "pre_tool_use", "pre-tool-use"]) {
        write("plugin.json", { ...base, hooks: { [spelling]: [{ hooks: [{ command: "c" }] }] } });
        expect(resolve().manifest?.hooks?.[0]?.event).toBe("pre_tool_use");
      }
    });
  });

  it("keeps a native Clarvis hooks array untouched", () => {
    write("plugin.json", { ...base, hooks: [{ event: "run_start", command: "echo hi" }] });
    expect(resolve().manifest?.hooks).toEqual([{ event: "run_start", command: "echo hi" }]);
  });

  it("keeps the plugin when its declared hooks file is missing, contributing no hooks", () => {
    write("plugin.json", { ...base, hooks: "./nope.json" });
    const { manifest, error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.name).toBe(base.name);
    expect(manifest?.hooks).toBeUndefined();
    expect(notes.join(" ")).toContain("nope.json");
  });

  it("keeps the plugin when its declared hooks file is not JSON", () => {
    write("plugin.json", { ...base, hooks: "./hooks/broken.json" });
    write("hooks/broken.json", "{nope");
    const { manifest, error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.hooks).toBeUndefined();
    expect(notes.join(" ")).toContain("not valid JSON");
  });

  it("keeps the plugin when a declared hooks document is over its byte ceiling", () => {
    write("plugin.json", { ...base, hooks: "./hooks/large.json" });
    write("hooks/large.json", "{}");
    truncateSync(join(root, "hooks/large.json"), PLUGIN_RESOURCE_LIMITS.hookDocumentBytes + 1);
    const { manifest, error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.hooks).toBeUndefined();
    expect(notes.join(" ")).toContain("resource limit");
  });

  it("does not partially load an oversized convention hooks document", () => {
    write("plugin.json", base);
    write("hooks/hooks.json", "{}");
    truncateSync(join(root, "hooks/hooks.json"), PLUGIN_RESOURCE_LIMITS.hookDocumentBytes + 1);
    const { manifest, error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.hooks).toBeUndefined();
    expect(notes.join(" ")).toContain("resource limit");
  });

  it("keeps the plugin when its declared hooks file is not a hooks document", () => {
    write("plugin.json", { ...base, hooks: "./hooks/other.json" });
    write("hooks/other.json", { SessionStart: "not a list of groups" });
    const { manifest, error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.hooks).toBeUndefined();
    expect(notes.join(" ")).toContain("recognizable hooks document");
  });

  it("reads a list of hooks files as one concatenated set", () => {
    write("plugin.json", { ...base, hooks: ["./hooks/a.json", "./hooks/b.json"] });
    write("hooks/a.json", { hooks: { SessionStart: [{ hooks: [{ command: "one" }] }] } });
    write("hooks/b.json", { hooks: { Stop: [{ hooks: [{ command: "two" }] }] } });
    const { manifest, error } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.hooks).toEqual([
      { event: "session_start", command: "one" },
      { event: "pre_finalize", command: "two" },
    ]);
  });

  it("keeps the readable half of a list of hooks files, naming the other", () => {
    write("plugin.json", { ...base, hooks: ["./hooks/a.json", "./hooks/gone.json"] });
    write("hooks/a.json", { hooks: { SessionStart: [{ hooks: [{ command: "one" }] }] } });
    const { manifest, error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.hooks).toEqual([{ event: "session_start", command: "one" }]);
    expect(notes.join(" ")).toContain("gone.json");
  });

  it("notes a convention file that parses but is not a hooks document", () => {
    write("plugin.json", base);
    write("hooks/hooks.json", { SessionStart: 7 });
    const { error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(notes.join(" ")).toContain("recognizable hooks document");
  });

  it("survives an unusable convention file with a note rather than an error", () => {
    write("plugin.json", base);
    write("hooks/hooks.json", "{not json");
    const { manifest, error, notes } = resolve();
    expect(error).toBeUndefined();
    expect(manifest?.hooks).toBeUndefined();
    expect(notes.join(" ")).toContain("hooks/hooks.json");
  });

  it("fingerprints the exact normalized hook that arrived from a file", () => {
    write("plugin.json", base);
    write("hooks/hooks.json", sessionStart);
    const fingerprint = (): string => hookFingerprint(resolve().manifest!.hooks![0]);
    const before = fingerprint();
    expect(before).toMatch(/^sha256:/);
    write("hooks/hooks.json", {
      hooks: { SessionStart: [{ hooks: [{ command: "something-else" }] }] },
    });
    expect(fingerprint()).not.toBe(before);
  });
});

describe("convertHooksDocument", () => {
  it("maps prompt expansion and Skill tool names without approximation", () => {
    const expansion = convertHooksDocument(
      { UserPromptExpansion: [{ hooks: [{ command: "feedback" }] }] },
      "/plugins/design",
    );
    const skill = convertHooksDocument(
      { PostToolUse: [{ matcher: "Skill", hooks: [{ command: "feedback" }] }] },
      "/plugins/design",
    );
    expect(expansion.hooks).toEqual([{ event: "user_prompt_expansion", command: "feedback" }]);
    expect(skill.hooks).toEqual([
      { event: "post_tool_use", command: "feedback", match: { tool: ["load_skill"] } },
    ]);
    expect([...expansion.notes, ...skill.notes]).toEqual([]);
  });

  it("reports an event with no Clarvis equivalent instead of guessing one", () => {
    const { hooks, notes } = convertHooksDocument(
      { Notification: [{ hooks: [{ command: "ping" }] }] },
      "/plugins/demo",
    );
    expect(hooks).toEqual([]);
    expect(notes.join(" ")).toContain("Notification");
  });

  it("warns that a blocking source event lands on an event that cannot block", () => {
    const { hooks, notes } = convertHooksDocument(
      { UserPromptSubmit: [{ hooks: [{ command: "scan-for-secrets" }] }] },
      "/plugins/demo",
    );
    expect(hooks).toHaveLength(1);
    expect(notes.join(" ")).toContain("notify-only");
  });

  it("stays quiet for a source event whose Clarvis counterpart can act on the verdict", () => {
    const { notes } = convertHooksDocument(
      { PreToolUse: [{ matcher: "shell", hooks: [{ command: "judge" }] }] },
      "/plugins/demo",
    );
    expect(notes).toEqual([]);
  });

  it("skips a matcher it cannot express rather than widening what the hook judges", () => {
    const { hooks, notes } = convertHooksDocument(
      { PreToolUse: [{ matcher: "^(?!Read).*$", hooks: [{ command: "judge" }] }] },
      "/plugins/demo",
    );
    expect(hooks).toEqual([]);
    expect(notes.join(" ")).toContain("skipped rather than guessed at");
  });

  it("treats a match-everything matcher as no filter", () => {
    const { hooks } = convertHooksDocument(
      { PostToolUse: [{ matcher: "*", hooks: [{ command: "audit" }] }] },
      "/plugins/demo",
    );
    expect(hooks).toEqual([{ event: "post_tool_use", command: "audit" }]);
  });

  it("converts alternation into a tool list and seconds into milliseconds", () => {
    const { hooks } = convertHooksDocument(
      { PreToolUse: [{ matcher: "^shell$|read_file", hooks: [{ command: "c", timeout: 2.5 }] }] },
      "/plugins/demo",
    );
    expect(hooks).toEqual([
      {
        event: "pre_tool_use",
        command: "c",
        match: { tool: ["shell", "read_file"] },
        timeout_ms: 2500,
      },
    ]);
  });

  it("round-trips every event the shared correspondence names, in both directions", () => {
    for (const [event, external] of Object.entries(EXTERNAL_HOOK_EVENT_NAMES)) {
      const { hooks, notes } = convertHooksDocument(
        { [external]: [{ hooks: [{ command: "c" }] }] },
        "/plug",
      );
      expect(hooks.map((h) => h.event as string)).toEqual([event]);
      expect(notes.join(" ")).not.toContain("no Clarvis equivalent");
    }
  });

  it("keeps the correspondence one-to-one, so inverting it loses nothing", () => {
    const externals = Object.values(EXTERNAL_HOOK_EVENT_NAMES);
    expect(new Set(externals).size).toBe(externals.length);
  });

  it("clamps a timeout past the Clarvis ceiling instead of emitting one the schema refuses", () => {
    const { hooks, notes } = convertHooksDocument(
      {
        PreToolUse: [
          {
            matcher: "shell",
            hooks: [
              { command: "fits", timeout: 30 },
              { command: "too-long", timeout: 300 },
            ],
          },
        ],
      },
      "/plug",
    );
    expect(hooks.map((h) => h.timeout_ms)).toEqual([30_000, MAX_HOOK_TIMEOUT_MS]);
    expect(notes.join(" ")).toContain("clamped to 60s");
  });

  it("keeps every well-formed hook beside an over-long one, so a plugin is never lost to it", () => {
    const { hooks } = convertHooksDocument(
      {
        PreToolUse: [
          {
            hooks: [
              { command: "fits", timeout: 30 },
              { command: "too-long", timeout: 600 },
            ],
          },
        ],
      },
      "/plug",
    );
    expect(hooks).toHaveLength(2);
    expect(hooks.every((h) => hookSchema.safeParse(h).success)).toBe(true);
  });

  it("skips an entry that is not a command, and notes an async request it cannot honour", () => {
    const { hooks, notes } = convertHooksDocument(
      {
        Stop: [
          {
            hooks: [
              { type: "http", command: "x" },
              { command: "y", async: true },
            ],
          },
        ],
      },
      "/plugins/demo",
    );
    expect(hooks).toEqual([{ event: "pre_finalize", command: "y" }]);
    expect(notes.join(" ")).toContain("type 'http'");
    expect(notes.join(" ")).toContain("async");
  });
});

describe("companion documents are confined to the plugin", () => {
  /** Write a file beside the plugin directory, i.e. outside it. */
  function writeOutside(name: string, body: unknown): string {
    const path = join(root, "..", name);
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
    return path;
  }

  it("refuses a servers document that climbs out, and still loads the plugin", () => {
    writeOutside("outside-servers.json", { mcpServers: { leaked: { command: "x" } } });
    write("plugin.json", { ...base, mcpServers: "../outside-servers.json" });

    const { manifest, error, notes } = resolve();

    expect(error).toBeUndefined();
    expect(manifest?.name).toBe("demo");
    expect(manifest?.mcpServers).toBeUndefined();
    expect(notes.join(" ")).toContain("resolves outside the plugin");
  });

  it("decides on the resolved path, so a climb through a subdirectory is refused too", () => {
    writeOutside("outside-servers.json", { mcpServers: { leaked: { command: "x" } } });
    write("plugin.json", { ...base, mcpServers: "skills/../../outside-servers.json" });

    const { manifest, notes } = resolve();

    expect(manifest?.mcpServers).toBeUndefined();
    expect(notes.join(" ")).toContain("resolves outside the plugin");
  });

  it("refuses an absolute servers path", () => {
    const outside = writeOutside("outside-servers.json", {
      mcpServers: { leaked: { command: "x" } },
    });
    write("plugin.json", { ...base, mcpServers: outside });

    const { manifest, notes } = resolve();

    expect(manifest?.mcpServers).toBeUndefined();
    expect(notes.join(" ")).toContain("resolves outside the plugin");
  });

  it("still reads a servers document that stays inside", () => {
    write("nested/.mcp.json", { mcpServers: { inside: { command: "x" } } });
    write("plugin.json", { ...base, mcpServers: "./nested/.mcp.json" });

    const { manifest, notes } = resolve();

    expect(manifest?.mcpServers?.inside).toMatchObject({ command: "x" });
    expect(notes.join(" ")).not.toContain("resolves outside");
  });

  it("reads no hooks from a named file that climbs out, keeping the plugin", () => {
    writeOutside("outside-hooks.json", [{ event: "pre_tool_use", command: "leak" }]);
    write("plugin.json", { ...base, hooks: "../outside-hooks.json" });

    const { manifest, error, notes } = resolve();

    expect(error).toBeUndefined();
    expect(manifest?.hooks).toBeUndefined();
    expect(notes.join(" ")).toContain("resolves outside the plugin");
  });
});

describe("a companion document never costs more than the key it fills", () => {
  it("withholds servers that would push the manifest past its ceiling, and keeps the plugin", () => {
    const filler = "x".repeat(1_500_000);
    const servers: Record<string, unknown> = {};
    for (let i = 0; i < 8000; i++) servers[`s${String(i)}`] = { command: "x".repeat(100) };
    write(".mcp.json", { mcpServers: servers });
    write("plugin.json", { ...base, mcpServers: "./.mcp.json", filler });

    const { manifest, error, notes } = resolve();

    expect(error).toBeUndefined();
    expect(manifest?.name).toBe("demo");
    expect(manifest?.mcpServers).toBeUndefined();
    expect(notes.join(" ")).toContain("would not fit in the manifest once inlined");
  });
});

describe("a manifest that lives in a host dot-directory", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clarvis-borrowed-base-"));
    mkdirSync(join(dir, ".alpha-plugin", "hooks"), { recursive: true });
    mkdirSync(join(dir, "skills", "greet"), { recursive: true });
    writeFileSync(
      join(dir, "skills", "greet", "SKILL.md"),
      "---\nname: greet\ndescription: Say hello.\n---\nHi.\n",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (manifest: Record<string, unknown>): void =>
    writeFileSync(join(dir, ".alpha-plugin", "plugin.json"), JSON.stringify(manifest));

  it("resolves a relative skills path from the manifest's own directory", () => {
    write({ name: "p", version: "1.0.0", skills: "../skills/" });
    const source = readPluginManifestSource(dir);
    expect("raw" in source).toBe(true);
    const location = "location" in source ? source.location : undefined;
    expect(location).toBe(".alpha-plugin/plugin.json");

    const { roots, notes } = pluginSkillRoots(dir, "../skills/", location);
    expect(roots).toEqual([join(dir, "skills")]);
    /* Resolved against the plugin root instead, `../skills/` escapes it and the
       plugin is told its own correct path is invalid. */
    expect(notes.join(" ")).not.toContain("outside the plugin");
  });

  it("finds the conventional hooks document beside that manifest", () => {
    write({ name: "p", version: "1.0.0" });
    writeFileSync(
      join(dir, ".alpha-plugin", "hooks", "hooks.json"),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
    );
    const source = readPluginManifestSource(dir);
    const raw = "raw" in source ? source.raw : "";
    const location = "location" in source ? source.location : undefined;
    const resolved = resolvePluginManifest(dir, raw, location);
    expect(resolved.manifest?.hooks?.length).toBe(1);
    expect(resolved.manifest?.hooks?.[0]?.command).toBe("echo hi");
  });

  it("still refuses a path that leaves the plugin from either base", () => {
    const { roots, notes } = pluginSkillRoots(dir, "../../elsewhere", ".alpha-plugin/plugin.json");
    expect(roots).toEqual([join(dir, "skills")]);
    expect(notes.join(" ")).toContain("outside the plugin");
  });

  it("leaves a root manifest resolving from the root, as before", () => {
    const { roots } = pluginSkillRoots(dir, "skills", "plugin.json");
    expect(roots).toEqual([join(dir, "skills")]);
  });
});

describe("borrowed relative hook commands", () => {
  it("anchors a relative hook from the selected borrowed manifest to the plugin root", () => {
    write(".alpha-plugin/plugin.json", { ...base, skills: "../skills" });
    write(".beta-plugin/plugin.json", {
      ...base,
      skills: "../skills",
      hooks: {
        SessionStart: [{ hooks: [{ command: "./hooks/run-hook.cmd session-start" }] }],
      },
    });

    expect(locationRead()).toBe(".beta-plugin/plugin.json");
    expect(resolve().manifest?.hooks).toEqual([
      {
        event: "session_start",
        command: `"${join(root, "hooks/run-hook.cmd")}" session-start`,
      },
    ]);
  });
});
