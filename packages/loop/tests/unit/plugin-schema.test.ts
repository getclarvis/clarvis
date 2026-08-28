import { describe, it, expect } from "../bun-test.ts";
import {
  pluginManifestSchema,
  pluginSettingsFragment,
  suspectedManifestTypos,
  unknownManifestKeys,
} from "../../src/settings/plugin-schema.ts";

const happy = {
  name: "demo",
  version: "1.0.0",
  description: "A demo plugin.",
};

function code(body: unknown): string | undefined {
  const r = pluginManifestSchema.safeParse(body);
  return r.success ? undefined : r.error.issues[0]!.code;
}

describe("pluginManifestSchema", () => {
  it("accepts a minimal manifest", () => {
    expect(pluginManifestSchema.safeParse(happy).success).toBe(true);
  });

  it("rejects a guard (D3: a plugin must not be able to disarm the workspace guard)", () => {
    const r = pluginManifestSchema.safeParse({ ...happy, guard: { type: "shell" } });
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error.issues[0]!.message).toContain("guard");
  });

  it("rejects a name that could spoof a namespace or escape a directory", () => {
    for (const name of ["has:colon", "has/slash", "..", "Has-Upper", "has space", ""]) {
      expect(pluginManifestSchema.safeParse({ ...happy, name }).success).toBe(false);
    }
  });

  it("installs on name alone, the one key the loader cannot do without", () => {
    expect(pluginManifestSchema.safeParse({ name: "demo" }).success).toBe(true);
    expect(pluginManifestSchema.safeParse({ version: "1.0.0" }).success).toBe(false);
  });

  it("requires non-empty version and description values when they are present", () => {
    expect(code({ name: "demo", version: "" })).toBe("too_small");
    expect(code({ name: "demo", description: "" })).toBe("too_small");
  });

  it("accepts ecosystem version labels without imposing SemVer", () => {
    expect(pluginManifestSchema.safeParse({ ...happy, version: "1.0" }).success).toBe(true);
    expect(pluginManifestSchema.safeParse({ ...happy, version: "v1.0.0" }).success).toBe(true);
    expect(pluginManifestSchema.safeParse({ ...happy, version: "1.0.0-rc.1" }).success).toBe(true);
  });

  it("carries unknown keys instead of refusing the manifest over them", () => {
    expect(code({ ...happy, bogus: 1 })).toBeUndefined();
    expect(code({ ...happy, skills: ["a"] })).toBeUndefined();
    expect(code({ ...happy, license: "MIT", homepage: "https://x" })).toBeUndefined();
  });

  it("names every unknown key, sorted, so nothing it ignores stays invisible", () => {
    expect(unknownManifestKeys({ ...happy, license: "MIT", agents: ["a"] })).toEqual([
      "agents",
      "license",
    ]);
    expect(unknownManifestKeys(happy)).toEqual([]);
    expect(unknownManifestKeys("not an object")).toEqual([]);
  });

  it("reads a near-miss of one of our keys as a misspelling, not as a foreign key", () => {
    expect(suspectedManifestTypos({ ...happy, mcpServer: {} })).toEqual([
      { key: "mcpServer", suggestion: "mcpServers" },
    ]);
    expect(suspectedManifestTypos({ ...happy, hook: [] })).toEqual([
      { key: "hook", suggestion: "hooks" },
    ]);
    expect(suspectedManifestTypos({ ...happy, bootstrapskill: "x" })).toEqual([
      { key: "bootstrapskill", suggestion: "bootstrapSkill" },
    ]);
  });

  it("does not accuse another host's vocabulary of being our typo", () => {
    const foreign = {
      ...happy,
      homepage: "h",
      repository: "r",
      license: "MIT",
      keywords: [],
      skills: "./skills/",
      sessionStart: {},
      skillInstructions: "s",
      interface: {},
      displayName: "d",
    };
    expect(suspectedManifestTypos(foreign)).toEqual([]);
    expect(unknownManifestKeys(foreign)).toHaveLength(9);
  });

  it("holds a short key to a tighter budget than a long one", () => {
    expect(suspectedManifestTypos({ ...happy, nxmx: "x" })).toEqual([]);
    expect(suspectedManifestTypos({ ...happy, mcpServrz: {} })).toEqual([
      { key: "mcpServrz", suggestion: "mcpServers" },
    ]);
    expect(suspectedManifestTypos({ ...happy, nome: "x" })).toEqual([
      { key: "nome", suggestion: "name" },
    ]);
  });

  it("says nothing about a manifest whose keys are all recognized", () => {
    expect(suspectedManifestTypos(happy)).toEqual([]);
    expect(suspectedManifestTypos("not an object")).toEqual([]);
  });

  it("accepts an author as a string or as the object other hosts write", () => {
    const parse = (author: unknown): unknown =>
      pluginManifestSchema.safeParse({ ...happy, author });
    expect(pluginManifestSchema.parse({ ...happy, author: "Jesse" }).author).toBe("Jesse");
    expect(
      pluginManifestSchema.parse({ ...happy, author: { name: "Jesse", email: "j@x" } }).author,
    ).toBe("Jesse");
    expect((parse({ email: "j@x" }) as { success: boolean }).success).toBe(false);
  });

  it("reuses the settings mcpServers refinement verbatim", () => {
    expect(
      pluginManifestSchema.safeParse({ ...happy, mcpServers: { s: { type: "stdio" } } }).success,
    ).toBe(false);
    expect(
      pluginManifestSchema.safeParse({
        ...happy,
        mcpServers: { s: { command: "x", resources: false } },
      }).success,
    ).toBe(true);
  });

  it("reuses the settings hooks schema verbatim", () => {
    expect(
      pluginManifestSchema.safeParse({
        ...happy,
        hooks: [
          { event: "pre_tool_use", match: { tool: "shell" }, command: "echo", on_failure: "deny" },
        ],
      }).success,
    ).toBe(true);
    expect(
      pluginManifestSchema.safeParse({ ...happy, hooks: [{ event: "on_start", command: "x" }] })
        .success,
    ).toBe(false);
  });

  it("accepts a bootstrapSkill naming one of the plugin's own skills", () => {
    expect(
      pluginManifestSchema.safeParse({ ...happy, bootstrapSkill: "using-superpowers" }).success,
    ).toBe(true);
  });

  it("rejects an empty or non-string bootstrapSkill, but does not constrain the charset", () => {
    expect(pluginManifestSchema.safeParse({ ...happy, bootstrapSkill: "" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...happy, bootstrapSkill: 42 }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...happy, bootstrapSkill: "Has Space" }).success).toBe(
      true,
    );
  });
});

describe("pluginSettingsFragment", () => {
  it("carries only the executable contributions, omitting absent keys", () => {
    expect(pluginSettingsFragment({ ...happy })).toEqual({});
    expect(
      pluginSettingsFragment({
        ...happy,
        mcpServers: { s: { type: "stdio", command: "x" } },
        hooks: [{ event: "pre_tool_use", command: "echo" }],
      }),
    ).toEqual({
      mcpServers: { s: { type: "stdio", command: "x" } },
      hooks: [{ event: "pre_tool_use", command: "echo" }],
    });
  });

  it("never carries bootstrapSkill, which must not reach merged settings", () => {
    expect(pluginSettingsFragment({ ...happy, bootstrapSkill: "using-superpowers" })).toEqual({});
  });
});
