import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { discoverSkills, resolveConfig, type SkillRegistry } from "@clarvis/skills";
import {
  captureWarnings,
  cleanup,
  makeWorkspace,
  writeSkill,
  type CapturedWarnings,
} from "../helpers/fixtures.ts";

describe("discovery diagnostics", () => {
  let workspace: string;
  let captured: CapturedWarnings;

  beforeEach(() => {
    workspace = makeWorkspace();
    captured = captureWarnings();
  });

  afterEach(() => {
    cleanup(workspace);
  });

  function scan(roots: string[]): SkillRegistry {
    return discoverSkills(
      resolveConfig({
        workspace,
        roots: roots.map((root, index) => ({ path: root, source: `r${String(index)}` })),
        warningSink: captured.warningSink,
        logger: captured.logger,
      }),
    );
  }

  it("summarizes one pass with the counters that answer why a skill is missing", () => {
    const lower = path.join(workspace, "lower");
    const upper = path.join(workspace, "upper");
    writeSkill(lower, "shared", { body: "lower" });
    writeSkill(upper, "shared", { body: "upper" });
    writeSkill(upper, "bare", { frontmatter: { description: null } });
    writeSkill(upper, "broken", { raw: "---\nname: [unclosed\n---\nbody\n" });

    const registry = scan([lower, upper]);
    expect(registry.size).toBe(2);

    const [summary] = captured.events("skills.discovered");
    expect(summary?.level).toBe("info");
    expect(summary?.fields).toMatchObject({
      roots: 2,
      skills: 2,
      shadowed: 1,
      defaulted: 1,
      dropped: 1,
    });
    expect(summary?.fields["ms"]).toBeGreaterThanOrEqual(0);
    expect(summary?.message).toContain("skill discovery finished");
  });

  it("names the winner and every loser of a cross-root collision", () => {
    const lower = path.join(workspace, "lower");
    const upper = path.join(workspace, "upper");
    writeSkill(lower, "shared", { body: "lower" });
    writeSkill(upper, "shared", { body: "upper" });

    scan([lower, upper]);

    const [collision] = captured.events("skill.shadowed");
    expect(collision?.level).toBe("warn");
    expect(collision?.fields).toMatchObject({
      skill: "shared",
      winner: { root: upper, scope: "workspace", source: "r1" },
      losers: [{ root: lower, scope: "workspace", source: "r0" }],
    });
  });

  it("names the manifest behind each rejection reason", () => {
    const root = path.join(workspace, "root");
    writeSkill(root, "broken", { raw: "---\nname: [unclosed\n---\nbody\n" });
    writeSkill(root, "first", { frontmatter: { name: "same" } });
    writeSkill(root, "second", { frontmatter: { name: "same" } });

    scan([root]);

    const reasons = captured.events("skill.rejected").map((record) => record.fields["reason"]);
    expect(reasons).toContain("parse");
    expect(reasons).toContain("duplicate");
    const parse = captured
      .events("skill.rejected")
      .find((record) => record.fields["reason"] === "parse");
    expect(parse?.level).toBe("debug");
    expect(parse?.fields["file"]).toBe(path.join(root, "broken", "SKILL.md"));
    expect(parse?.fields["cause"]).toEqual(expect.any(String));
  });

  it("records a supplied field by length and never by value", () => {
    const root = path.join(workspace, "root");
    writeSkill(root, "bare", { frontmatter: { description: null } });

    scan([root]);

    const [defaulted] = captured.events("skill.field_defaulted");
    expect(defaulted?.level).toBe("debug");
    expect(defaulted?.fields).toMatchObject({
      skill: "bare",
      field: "description",
      dir: path.join(root, "bare"),
    });
    expect(defaulted?.fields["chars"]).toBeGreaterThan(0);
    expect(Object.keys(defaulted?.fields ?? {})).not.toContain("value");
  });

  it("reports a body disclosure by size, never by content", () => {
    const root = path.join(workspace, "root");
    writeSkill(root, "demo", { body: "the body", resources: { "references/a.md": "a" } });

    const registry = scan([root]);
    expect(registry.get("demo")?.body).toContain("the body");

    const [disclosed] = captured.events("skill.body_disclosed");
    expect(disclosed?.level).toBe("debug");
    expect(disclosed?.fields).toMatchObject({ skill: "demo", resources: 1 });
    expect(disclosed?.fields["chars"]).toBeGreaterThan(0);
    expect(JSON.stringify(disclosed?.fields)).not.toContain("the body");
  });

  it("warns when a catalogued manifest was renamed underneath the registry", () => {
    const root = path.join(workspace, "root");
    writeSkill(root, "stable", { body: "catalogued" });
    const registry = scan([root]);

    writeSkill(root, "renamed", { dirName: "stable", body: "different identity" });

    expect(() => registry.get("stable")).toThrow(/refresh required/);
    const [renamed] = captured.events("skill.name_changed");
    expect(renamed?.level).toBe("warn");
    expect(renamed?.fields).toMatchObject({ skill: "stable", actual: "renamed" });
  });

  it("reports a resource read that cannot be stat'd as missing", () => {
    const root = path.join(workspace, "root");
    const dir = writeSkill(root, "demo", { resources: { "references/a.md": "a" } });
    const registry = scan([root]);
    rmSync(path.join(dir, "references", "a.md"));

    expect(() => registry.resource("demo", "references/a.md")).toThrow(/No such resource/);
    expect(captured.events("skill.resource_missing")[0]?.fields).toMatchObject({
      skill: "demo",
      rel: "references/a.md",
    });
  });

  it("reports a dangling symlink and an escaping one as skipped resources", () => {
    const root = path.join(workspace, "root");
    const outside = path.join(workspace, "outside.md");
    writeFileSync(outside, "outside");
    const dir = writeSkill(root, "demo");
    mkdirSync(path.join(dir, "references"));
    symlinkSync(path.join(dir, "references", "gone.md"), path.join(dir, "references", "dead.md"));
    symlinkSync(outside, path.join(dir, "references", "away.md"));

    const registry = scan([root]);
    expect(registry.get("demo")?.resources).toEqual([]);

    const reasons = new Set(
      captured.events("skill.resource_skipped").map((record) => record.fields["reason"]),
    );
    expect(reasons.has("dangling")).toBe(true);
    expect(reasons.has("escaping_symlink")).toBe(true);
  });

  it("reports a root that cannot be listed", () => {
    scan([path.join(workspace, "absent")]);

    expect(captured.events("skill.dir_unreadable")[0]?.fields["path"]).toBe(
      path.join(workspace, "absent"),
    );
  });
});
