import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSkills, resolveConfig } from "@clarvis/skills";
import { SkillError } from "../../src/errors.ts";
import { renderSkillCatalog } from "@clarvis/skills/catalog";
import { handleLoadSkillCall, renderSkillsSection } from "@clarvis/skills/capability";
import type { SkillInfo, SkillRegistry } from "../../src/types.ts";
import { makeTrace } from "../helpers/capability-fakes.ts";
import { call, validateArgs } from "../helpers/call-fixtures.ts";
import { captureWarnings, cleanup, makeWorkspace } from "../helpers/fixtures.ts";

/**
 * The committed foreign-dialect skill tree: one skill with a well-formed
 * sidecar, one whose sidecar is malformed, several with none, and the
 * required-field gaps a foreign manifest is allowed to leave.
 */
const FIXTURE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "foreign-skills",
);

/**
 * Strings that exist only inside a sidecar; none may reach a model-facing
 * surface. The icon *paths* are deliberately absent from this list: they name
 * files that are also ordinary bundled assets, so their appearance in a resource
 * listing proves nothing either way.
 */
const SIDECAR_ONLY_TEXT = [
  "Release Notes",
  "Turns a commit range into publishable notes",
  "#3b82f6",
  "#3B82F6",
  "Draft the notes for everything since the last tag",
  "implicit-invocation",
  "Ledger Reconciliation",
] as const;

/** The tail the skills section appends under a rendered catalog. */
const CATALOG_INSTRUCTION = "Call the `load_skill` tool with a skill's `name`";

describe("harness-directed skill sidecar", () => {
  let ws: string;
  let warnings: string[];
  let registry: SkillRegistry;
  const tempRoots: string[] = [];

  function discover(root: string, strict = false): SkillRegistry {
    const cap = captureWarnings();
    warnings = cap.warnings;
    return discoverSkills(
      resolveConfig({
        home: ws,
        cwd: ws,
        workspace: ws,
        strict,
        warningSink: cap.warningSink,
        roots: [{ path: root, scope: "workspace", source: "agents" }],
      }),
    );
  }

  function info(name: string): SkillInfo {
    const found = registry.list().find((skill) => skill.name === name);
    if (found === undefined) throw new Error(`fixture skill '${name}' is missing from the catalog`);
    return found;
  }

  beforeEach(() => {
    ws = makeWorkspace();
    registry = discover(FIXTURE_ROOT);
  });

  afterEach(() => {
    cleanup(ws);
    for (const dir of tempRoots.splice(0)) cleanup(dir);
  });

  describe("presentation", () => {
    it("reads every presentation field a sidecar declares", () => {
      expect(info("presented").presentation).toEqual({
        displayName: "Release Notes",
        shortDescription: "Turns a commit range into publishable notes.",
        icons: { light: "assets/icon-light.svg", dark: "assets/icon-dark.svg" },
        color: "#3b82f6",
        starterPrompt: "Draft the notes for everything since the last tag.",
      });
    });

    it("leaves the manifest's own description authoritative", () => {
      expect(info("presented").description).toBe("Draft release notes from a commit range.");
    });

    it("reads a short description from the manifest's metadata bucket", () => {
      expect(info("metadata-short").presentation).toEqual({
        shortDescription: "Lockfile drift, at a glance.",
      });
    });

    it("carries no presentation for a skill that declares none", () => {
      expect(info("plain").presentation).toBeUndefined();
    });

    it("prefers the sidecar's short description over the manifest's", () => {
      const dir = writeTempSkill("both", {
        frontmatter: "metadata:\n  short-description: from the manifest",
        sidecar: "short-description: from the sidecar",
      });
      const local = discover(path.dirname(dir));
      expect(local.list()[0]?.presentation?.shortDescription).toBe("from the sidecar");
    });
  });

  describe("the two gating axes are independent", () => {
    it("suppresses a skill from the catalog while leaving it user-invocable", () => {
      const skill = info("suppressed");
      expect(skill.catalogSuppressed).toBe(true);
      expect(skill.userInvocable).toBe(true);
    });

    it("keeps a non-user-invocable skill in the catalog", () => {
      const skill = info("slash-hidden");
      expect(skill.userInvocable).toBe(false);
      expect(skill.catalogSuppressed).toBeUndefined();
      expect(renderSkillCatalog(registry.list())).toContain("**slash-hidden**");
    });

    it("withholds a suppressed skill from the rendered catalog only", () => {
      const catalog = renderSkillCatalog(registry.list());
      expect(catalog).not.toContain("**suppressed**");
      expect(catalog).toContain("**presented**");
      expect(registry.list().map((s) => s.name)).toContain("suppressed");
    });

    it("keeps a suppressed skill explicitly loadable", () => {
      expect(registry.get("suppressed")?.body).toContain("Walk the ledger");
    });

    it("drops the whole section, and its load instruction, when every skill is suppressed", () => {
      const suppressedOnly = registry.list().filter((s) => s.catalogSuppressed === true);
      expect(suppressedOnly.length).toBeGreaterThan(0);
      expect(renderSkillsSection(suppressedOnly)).toBe("");
    });

    it("still renders bootstrap bodies when the catalog is empty", () => {
      const suppressedOnly = registry.list().filter((s) => s.catalogSuppressed === true);
      const section = renderSkillsSection(suppressedOnly, [
        { plugin: "p", skill: "s", body: "BOOTSTRAP BODY" },
      ]);
      expect(section).toContain("BOOTSTRAP BODY");
      expect(section).not.toContain(CATALOG_INSTRUCTION);
    });
  });

  describe("the sidecar never reaches the model", () => {
    it("keeps sidecar content out of the catalog and the skills section", () => {
      const rendered = renderSkillCatalog(registry.list()) + renderSkillsSection(registry.list());
      for (const fragment of SIDECAR_ONLY_TEXT) expect(rendered).not.toContain(fragment);
    });

    it("keeps sidecar content out of a load_skill result and its resource listing", () => {
      const content = registry.get("presented");
      const result = handleLoadSkillCall({
        call: call({ arguments: { name: "presented" } }),
        skills: {
          listSkills: () => registry.list(),
          loadSkill: (name) => registry.get(name),
          readResource: (name, rel) => registry.readResource(name, rel),
        },
        trace: makeTrace(),
        agent: "lead",
        iteration: 1,
        validateArgs,
      });
      expect(result.error).toBe(false);
      for (const fragment of SIDECAR_ONLY_TEXT) expect(result.text).not.toContain(fragment);
      expect(content?.body ?? "").not.toContain("display-name");
    });

    it("omits the harness directory from the enumerated resources", () => {
      const rels = registry.get("presented")?.resources.map((r) => r.rel) ?? [];
      expect(rels).toEqual([
        "assets/icon-dark.svg",
        "assets/icon-light.svg",
        "references/grouping.md",
      ]);
    });

    it("refuses to resolve or read a resource inside the harness directory", () => {
      expect(() => registry.resource("presented", "agents/harness.yaml")).toThrow(SkillError);
      expect(() => registry.readResource("presented", "agents/harness.yaml")).toThrow(
        /No such resource/,
      );
      expect(() => registry.resource("presented", "./agents/harness.yaml")).toThrow(SkillError);
    });

    it("refuses a symlink inside the skill that points at the harness directory", () => {
      const dir = writeTempSkill("aliased", { sidecar: "display-name: Aliased" });
      symlinkSync(path.join(dir, "agents"), path.join(dir, "elsewhere"));
      const local = discover(path.dirname(dir));
      expect(() => local.resource("aliased", "elsewhere/harness.yaml")).toThrow(/No such resource/);
    });
  });

  describe("degradation", () => {
    it("keeps a skill whose sidecar is malformed fully present in the catalog", () => {
      const skill = info("broken-sidecar");
      expect(skill.description).toBe("Summarize an incident timeline.");
      expect(skill.presentation).toBeUndefined();
      expect(skill.catalogSuppressed).toBeUndefined();
      expect(renderSkillCatalog(registry.list())).toContain("**broken-sidecar**");
      expect(registry.get("broken-sidecar")?.body).toContain("Collect the events");
    });

    it("reports the malformed sidecar as a warning", () => {
      expect(warnings.join("")).toMatch(/ignoring unreadable skill sidecar/);
    });

    it("keeps a malformed sidecar from failing even a strict scan", () => {
      expect(() => discover(FIXTURE_ROOT, true)).not.toThrow();
    });

    it("skips a sidecar whose target escapes the skill directory", () => {
      const outside = mkdtempSync(path.join(tmpdir(), "clarvis-skills-outside-"));
      writeFileSync(path.join(outside, "harness.yaml"), "display-name: Escaped\n");
      const dir = writeTempSkill("escaper", {});
      mkdirSync(path.join(dir, "agents"), { recursive: true });
      symlinkSync(path.join(outside, "harness.yaml"), path.join(dir, "agents", "harness.yaml"));
      try {
        const local = discover(path.dirname(dir));
        expect(local.list()[0]?.presentation).toBeUndefined();
        expect(warnings.join("")).toMatch(/skipping skill sidecar escaping skill dir/);
      } finally {
        cleanup(outside);
      }
    });

    it("ignores a sidecar file whose extension is not YAML", () => {
      const dir = writeTempSkill("wrong-ext", {});
      mkdirSync(path.join(dir, "agents"), { recursive: true });
      writeFileSync(path.join(dir, "agents", "harness.json"), '{"display-name":"Ignored"}');
      const local = discover(path.dirname(dir));
      expect(local.list()[0]?.presentation).toBeUndefined();
    });

    it("prefers the canonical OpenAI sidecar names deterministically", () => {
      const dir = writeTempSkill("ranked-sidecar", {});
      mkdirSync(path.join(dir, "agents"), { recursive: true });
      writeFileSync(path.join(dir, "agents", "harness.yaml"), "display-name: Harness\n");
      writeFileSync(path.join(dir, "agents", "openai.yml"), "display-name: OpenAI YML\n");
      writeFileSync(path.join(dir, "agents", "openai.yaml"), "display-name: OpenAI YAML\n");

      const local = discover(path.dirname(dir));
      expect(local.list()[0]?.presentation?.displayName).toBe("OpenAI YAML");
    });
  });

  describe("required fields Clarvis supplies", () => {
    it("keeps a skill that declares no description, defaulting from its presentation", () => {
      const skill = info("no-description");
      expect(skill.description).toBe("Imports a ledger export into the workspace.");
      expect(skill.defaulted).toEqual(["description"]);
      expect(renderSkillCatalog(registry.list())).toContain(
        "**no-description** — Imports a ledger export into the workspace.",
      );
    });

    it("keeps a skill that declares no name, defaulting from its directory", () => {
      const skill = info("no-name");
      expect(skill.name).toBe("no-name");
      expect(skill.defaulted).toEqual(["name"]);
      expect(skill.description).toBe("Bisect a regression across a commit range.");
      expect(registry.get("no-name")?.body).toContain("Bisect, then report");
    });

    it("supplies a neutral placeholder rather than inventing a description", () => {
      const skill = info("bare");
      expect(skill.name).toBe("bare");
      expect(skill.description).toBe("(no description supplied)");
      expect(skill.defaulted).toEqual(["name", "description"]);
    });

    it("makes every supplied field visible as a warning", () => {
      expect(warnings.join("")).toMatch(/declares no usable 'description'; using/);
      expect(warnings.join("")).toMatch(/declares no usable 'name'; using 'no-name'/);
    });

    it("records nothing on a skill whose manifest declares both", () => {
      expect(info("plain").defaulted).toBeUndefined();
    });

    it("does not warn about a name mismatch it supplied itself", () => {
      expect(warnings.join("")).not.toMatch(/'no-name' does not match directory/);
    });

    it("supplies a name for a value written in a shape we cannot use", () => {
      const dir = writeTempSkill("listy", { name: "[a, b]", description: "still here" });
      const local = discover(path.dirname(dir));
      expect(local.list()[0]?.name).toBe("listy");
      expect(local.list()[0]?.defaulted).toEqual(["name"]);
    });

    it("falls back to a neutral name when the directory name yields none", () => {
      const dir = writeTempSkill("???", { description: "still here" });
      const local = discover(path.dirname(dir));
      expect(local.list()[0]?.name).toBe("skill");
    });

    it("keeps a manifest with no frontmatter at all", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "clarvis-skills-tmp-"));
      const skillDir = path.join(dir, "fenceless");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, "SKILL.md"), "No frontmatter, just prose.\n");
      tempRoots.push(dir);
      const local = discover(dir);
      expect(local.list()[0]?.name).toBe("fenceless");
      expect(local.get("fenceless")?.body).toBe("No frontmatter, just prose.");
    });
  });

  /** Write one throwaway skill directory under a fresh root, returning the skill directory. */
  function writeTempSkill(
    dirName: string,
    opts: { name?: string; description?: string; frontmatter?: string; sidecar?: string },
  ): string {
    const root = mkdtempSync(path.join(tmpdir(), "clarvis-skills-tmp-"));
    tempRoots.push(root);
    const dir = path.join(root, dirName);
    mkdirSync(dir, { recursive: true });
    const lines = [
      "---",
      ...(opts.name === undefined ? [`name: ${dirName}`] : [`name: ${opts.name}`]),
      `description: ${opts.description ?? "a fixture skill"}`,
      ...(opts.frontmatter === undefined ? [] : [opts.frontmatter]),
      "---",
      "",
      "Body.",
      "",
    ];
    writeFileSync(path.join(dir, "SKILL.md"), lines.join("\n"));
    if (opts.sidecar !== undefined) {
      mkdirSync(path.join(dir, "agents"), { recursive: true });
      writeFileSync(path.join(dir, "agents", "harness.yaml"), `${opts.sidecar}\n`);
    }
    return dir;
  }
});
