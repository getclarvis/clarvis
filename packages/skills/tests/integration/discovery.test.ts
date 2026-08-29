import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { discoverSkills, resolveConfig } from "@clarvis/skills";
import {
  clarvisRoots,
  cleanup,
  makeHome,
  makeWorkspace,
  skillsRoot,
  userSkillsRoot,
  writeSkill,
} from "../helpers/fixtures.ts";

describe("root discovery and shadowing", () => {
  let home: string;
  let workspace: string;

  beforeEach(() => {
    home = makeHome();
    workspace = makeWorkspace();
  });

  afterEach(() => {
    cleanup(home);
    cleanup(workspace);
  });

  it("applies the complete Clarvis root order and retains every shadowed origin", () => {
    writeSkill(skillsRoot(home, "agents"), "demo", { body: "user agents" });
    writeSkill(skillsRoot(workspace, "agents"), "demo", { body: "workspace agents" });
    writeSkill(userSkillsRoot(home), "demo", { body: "user clarvis" });
    writeSkill(skillsRoot(workspace, "clarvis"), "demo", { body: "workspace clarvis" });

    const registry = discoverSkills(
      resolveConfig({
        home,
        cwd: workspace,
        workspace,
        strict: true,
        roots: clarvisRoots(home, workspace),
      }),
    );

    const winner = registry.get("demo");
    expect(winner).toMatchObject({
      body: "workspace clarvis",
      scope: "workspace",
      source: "clarvis",
    });
    expect(winner?.shadowed?.map(({ source, scope }) => `${source}:${scope}`)).toEqual([
      "clarvis:user",
      "agents:workspace",
      "agents:user",
    ]);
    expect(registry.size).toBe(1);
  });

  it("applies last-root-wins to arbitrary caller roots while merging distinct skills", () => {
    const lower = path.join(workspace, "lower-store");
    const upper = path.join(workspace, "upper-store");
    writeSkill(lower, "demo", { body: "lower" });
    writeSkill(lower, "only-lower");
    writeSkill(upper, "demo", { body: "upper" });

    const registry = discoverSkills(
      resolveConfig({
        home,
        cwd: workspace,
        workspace,
        roots: [
          { path: lower, source: "lower" },
          { path: upper, source: "upper" },
        ],
      }),
    );

    expect(registry.list().map((skill) => skill.name)).toEqual(["demo", "only-lower"]);
    expect(registry.get("demo")).toMatchObject({
      body: "upper",
      source: "upper",
      scope: "workspace",
      shadowed: [expect.objectContaining({ source: "lower", scope: "workspace" })],
    });
  });

  it("admits only exact manifest names from a root allowlist", () => {
    const root = path.join(workspace, "selected-store");
    writeSkill(root, "keep", { body: "kept" });
    writeSkill(root, "drop", { body: "dropped" });

    const selected = discoverSkills(
      resolveConfig({
        home,
        cwd: workspace,
        workspace,
        roots: [{ path: root, source: "selected", include: ["keep"] }],
      }),
    );
    const empty = discoverSkills(
      resolveConfig({
        home,
        cwd: workspace,
        workspace,
        roots: [{ path: root, source: "selected", include: [] }],
      }),
    );

    expect(selected.list().map((skill) => skill.name)).toEqual(["keep"]);
    expect(empty.size).toBe(0);
  });

  it("applies Agent Skills identity validation only to roots that request it", () => {
    const root = path.join(workspace, "portable-skills");
    writeSkill(root, "valid", {
      frontmatter: {
        license: "Apache-2.0",
        compatibility: "Requires network access",
        metadata: { author: "clarvis", version: "1" },
        "allowed-tools": "Bash(git:*) Read",
      },
    });
    writeSkill(root, "mismatch", { dirName: "other-directory" });
    writeSkill(root, "missing-description", {
      raw: "---\nname: missing-description\n---\nbody\n",
    });
    writeSkill(root, "Uppercase");
    const longName = "a".repeat(65);
    writeSkill(root, longName);
    writeSkill(root, "bad-license", { frontmatter: { license: 1 } });
    writeSkill(root, "bad-compatibility", {
      frontmatter: { compatibility: "x".repeat(501) },
    });
    writeSkill(root, "bad-metadata", { frontmatter: { metadata: { version: 1 } } });
    writeSkill(root, "bad-tools", { frontmatter: { "allowed-tools": ["Read"] } });
    writeSkill(path.join(root, "group"), "nested");
    const warnings: string[] = [];

    const registry = discoverSkills(
      resolveConfig({
        home,
        cwd: workspace,
        workspace,
        warningSink: (message) => warnings.push(message),
        roots: [
          {
            path: root,
            discovery: "immediate",
            manifestName: "exact",
            validation: "agent-skills",
            confinementRoot: root,
          },
        ],
      }),
    );

    expect(registry.list().map((skill) => skill.name)).toEqual(["valid"]);
    expect(registry.get("valid")?.allowedTools).toEqual(["Bash(git:*)", "Read"]);
    expect(warnings.join(" ")).toContain("requires description");
    expect(warnings.join(" ")).toContain("must match directory");
    expect(warnings.join(" ")).toContain("lowercase alphanumeric");
    expect(warnings.join(" ")).toContain("at most 64 characters");
    expect(warnings.join(" ")).toContain("license must be a string");
    expect(warnings.join(" ")).toContain("compatibility must contain 1-500 characters");
    expect(warnings.join(" ")).toContain("metadata must map string keys to string values");
    expect(warnings.join(" ")).toContain("allowed-tools must be a space-separated string");
  });
});
