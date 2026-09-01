import { mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { discoverSkills, resolveConfig } from "@clarvis/skills";
import { SkillError } from "../../src/errors.ts";
import {
  MAX_SKILL_DIRECTORY_ENTRIES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILE_CHARS,
  MAX_SKILL_FRONTMATTER_BYTES,
  MAX_SKILL_FRONTMATTER_CHARS,
  MAX_SKILL_RESOURCE_BYTES,
  MAX_SKILL_RESOURCE_CHARS,
  MAX_SKILL_RESOURCE_DEPTH,
  MAX_SKILL_RESOURCE_DIRECTORIES,
  MAX_SKILL_RESOURCE_ENTRIES,
  MAX_SKILL_RESOURCES,
  MAX_SKILL_ROOTS,
  MAX_SKILLS,
  MAX_SKILLS_PER_ROOT,
} from "../../src/limits.ts";
import { enumerateResources, listSkillDirs } from "../../src/scan.ts";
import {
  captureWarnings,
  cleanup,
  makeWorkspace,
  writeSkill,
  type CapturedWarnings,
} from "../helpers/fixtures.ts";

function registry(workspace: string, root: string, captured?: CapturedWarnings) {
  return discoverSkills(
    resolveConfig({
      workspace,
      roots: [{ path: root, source: "bounds" }],
      ...(captured === undefined
        ? {}
        : { warningSink: captured.warningSink, logger: captured.logger }),
    }),
  );
}

describe("skills hard bounds", () => {
  it("rejects an unbounded configured root list before scanning", () => {
    const workspace = makeWorkspace();
    try {
      expect(() =>
        resolveConfig({
          workspace,
          roots: Array.from({ length: MAX_SKILL_ROOTS + 1 }, (_, index) => ({
            path: path.join(workspace, `root-${String(index)}`),
          })),
        }),
      ).toThrow(/at most/);
    } finally {
      cleanup(workspace);
    }
  });

  it("does not retain bodies during discovery and reads one only on first disclosure", () => {
    const workspace = makeWorkspace();
    try {
      const root = path.join(workspace, "skills");
      writeSkill(root, "lazy", { body: "body-before-discovery" });
      const found = registry(workspace, root);
      expect(found.list()[0]).not.toHaveProperty("body");

      writeSkill(root, "lazy", { body: "body-loaded-on-demand" });
      expect(found.get("lazy")?.body).toBe("body-loaded-on-demand");

      writeSkill(root, "lazy", { body: "body-after-first-load" });
      expect(found.get("lazy")?.body).toBe("body-loaded-on-demand");
    } finally {
      cleanup(workspace);
    }
  });

  it("rejects a manifest whose identity changes after discovery", () => {
    const workspace = makeWorkspace();
    try {
      const root = path.join(workspace, "skills");
      writeSkill(root, "stable-name", { body: "catalogued body" });
      const found = registry(workspace, root);

      writeSkill(root, "renamed", {
        dirName: "stable-name",
        body: "body with a different identity",
      });

      expect(() => found.get("stable-name")).toThrow(/name changed.*refresh required/);
    } finally {
      cleanup(workspace);
    }
  });

  it("rejects an oversized sparse SKILL.md before disclosure", () => {
    const workspace = makeWorkspace();
    const warnings = captureWarnings();
    try {
      const root = path.join(workspace, "skills");
      const dir = writeSkill(root, "oversized");
      truncateSync(path.join(dir, "SKILL.md"), MAX_SKILL_FILE_BYTES + 1);

      const found = registry(workspace, root, warnings);
      expect(found.size).toBe(0);
      expect(warnings.warnings.join("")).toContain("maximum bytes");
    } finally {
      cleanup(workspace);
    }
  });

  it("rejects frontmatter whose fence or decoded metadata exceeds its prefix budget", () => {
    const workspace = makeWorkspace();
    const warnings = captureWarnings();
    try {
      const root = path.join(workspace, "skills");
      writeSkill(root, "fence-too-late", {
        raw:
          "---\nname: fence-too-late\ndescription: " +
          "x".repeat(MAX_SKILL_FRONTMATTER_BYTES) +
          "\n---\nbody\n",
      });
      writeSkill(root, "metadata-too-long", {
        raw:
          "---\nname: metadata-too-long\ndescription: valid\nextra: " +
          "x".repeat(MAX_SKILL_FRONTMATTER_CHARS) +
          "\n---\nbody\n",
      });

      const found = registry(workspace, root, warnings);
      expect(found.size).toBe(0);
      expect(warnings.warnings.join("")).toMatch(/closing '---' fence|frontmatter exceeds/);
    } finally {
      cleanup(workspace);
    }
  });

  it("bounds decoded SKILL.md characters when the byte cap still admits the file", () => {
    const workspace = makeWorkspace();
    try {
      const root = path.join(workspace, "skills");
      writeSkill(root, "long-body", { body: "x".repeat(MAX_SKILL_FILE_CHARS + 1) });
      const found = registry(workspace, root);

      expect(found.list().map(({ name }) => name)).toEqual(["long-body"]);
      expect(() => found.get("long-body")).toThrow(/maximum characters/);
    } finally {
      cleanup(workspace);
    }
  });

  it("caps manifests per root and distinct skills globally without changing winners", () => {
    const workspace = makeWorkspace();
    const warnings = captureWarnings();
    try {
      const first = path.join(workspace, "first");
      const second = path.join(workspace, "second");
      const third = path.join(workspace, "third");
      for (let index = 0; index <= MAX_SKILLS_PER_ROOT; index += 1) {
        writeSkill(first, `a-${String(index).padStart(4, "0")}`);
      }
      for (let index = 0; index < MAX_SKILLS_PER_ROOT; index += 1) {
        writeSkill(second, `b-${String(index).padStart(4, "0")}`);
      }
      writeSkill(third, "a-0000", { body: "highest-precedence" });
      writeSkill(third, "0-extra");

      const found = discoverSkills(
        resolveConfig({
          workspace,
          roots: [{ path: first }, { path: second }, { path: third }],
          warningSink: warnings.warningSink,
        }),
      );

      expect(found.size).toBe(MAX_SKILLS);
      expect(found.get("a-0000")?.body).toBe("highest-precedence");
      expect(found.list().some(({ name }) => name === "0-extra")).toBe(true);
      expect(found.list().some(({ name }) => name === "b-0255")).toBe(false);
      expect(warnings.warnings.join("")).toMatch(/manifests|distinct skills/);

      expect(() =>
        discoverSkills(resolveConfig({ workspace, roots: [{ path: first }], strict: true })),
      ).toThrow(/more than .* manifests/);

      rmSync(path.join(first, `a-${String(MAX_SKILLS_PER_ROOT).padStart(4, "0")}`), {
        recursive: true,
      });
      expect(() =>
        discoverSkills(
          resolveConfig({
            workspace,
            roots: [{ path: first }, { path: second }, { path: third }],
            strict: true,
          }),
        ),
      ).toThrow(/more than .* distinct skills/);
    } finally {
      cleanup(workspace);
    }
  });

  it("drops a directory atomically when its streamed entry cap is exceeded", () => {
    const workspace = makeWorkspace();
    const warnings = captureWarnings();
    try {
      for (let index = 0; index <= MAX_SKILL_DIRECTORY_ENTRIES; index += 1) {
        writeFileSync(path.join(workspace, `entry-${String(index).padStart(5, "0")}`), "");
      }
      expect(listSkillDirs(workspace, true, warnings)).toEqual([]);
      expect(warnings.warnings.join("")).toContain("more than");
    } finally {
      cleanup(workspace);
    }
  });

  it("bounds resource depth and file count with deterministic partial disclosure", () => {
    const workspace = makeWorkspace();
    const warnings = captureWarnings();
    try {
      const dir = writeSkill(workspace, "resources");
      const many = path.join(dir, "references");
      mkdirSync(many, { recursive: true });
      for (let index = 0; index <= MAX_SKILL_RESOURCES; index += 1) {
        writeFileSync(path.join(many, `resource-${String(index).padStart(5, "0")}.txt`), "x");
      }
      let deep = path.join(dir, "deep");
      for (let depth = 0; depth <= MAX_SKILL_RESOURCE_DEPTH; depth += 1) {
        deep = path.join(deep, `d${String(depth)}`);
        mkdirSync(deep, { recursive: true });
      }
      writeFileSync(path.join(deep, "hidden.txt"), "hidden");

      const resources = enumerateResources(dir, true, warnings);
      expect(resources).toHaveLength(MAX_SKILL_RESOURCES);
      expect(resources.some(({ rel }) => rel.endsWith("hidden.txt"))).toBe(false);
      expect(warnings.warnings.join("")).toMatch(/resource file limit|deeper than/);
    } finally {
      cleanup(workspace);
    }
  });

  it("bounds the number of resource directories entered", () => {
    const workspace = makeWorkspace();
    const warnings = captureWarnings();
    try {
      const dir = writeSkill(workspace, "directory-budget");
      for (let index = 0; index < MAX_SKILL_RESOURCE_DIRECTORIES; index += 1) {
        mkdirSync(path.join(dir, `bucket-${String(index).padStart(4, "0")}`));
      }

      expect(enumerateResources(dir, false, warnings)).toEqual([]);
      expect(warnings.warnings.join("")).toContain("resource directory limit");
    } finally {
      cleanup(workspace);
    }
  });

  it("treats an unreadable or vanished resource root as an empty disclosure", () => {
    const workspace = makeWorkspace();
    try {
      expect(enumerateResources(path.join(workspace, "missing"), false)).toEqual([]);
    } finally {
      cleanup(workspace);
    }
  });

  it("stops before opening a directory the entry budget leaves no room for", () => {
    // The budget can be spent exactly rather than overshot, and the two arms
    // that notice differ: overshooting breaks after listing a directory, while
    // landing on the boundary must refuse the *next* one before opening it.
    // Symlinks pad the count without becoming resources, so the totals below
    // are the whole of what the walk inspects.
    const workspace = makeWorkspace();
    const warnings = captureWarnings();
    try {
      const dir = writeSkill(workspace, "exact-budget");
      const rootEntries = 1 + 3;
      const firstBucket = MAX_SKILL_DIRECTORY_ENTRIES;
      const secondBucket = MAX_SKILL_RESOURCE_ENTRIES - rootEntries - firstBucket;
      const fill = (bucket: string, count: number): void => {
        const resourceDir = path.join(dir, bucket);
        mkdirSync(resourceDir, { recursive: true });
        for (let index = 0; index < count; index += 1) {
          symlinkSync("missing", path.join(resourceDir, `e-${String(index).padStart(5, "0")}`));
        }
      };
      fill("a-first", firstBucket);
      fill("b-second", secondBucket);
      mkdirSync(path.join(dir, "c-never-opened"));

      expect(enumerateResources(dir, false, warnings)).toEqual([]);
      const limitWarnings = warnings.warnings.filter((w) => w.includes("resource entry limit"));
      expect(limitWarnings).toHaveLength(1);
    } finally {
      cleanup(workspace);
    }
  });

  it("charges rejected directory entries to the resource-wide traversal budget", () => {
    const workspace = makeWorkspace();
    const warnings = captureWarnings();
    try {
      const dir = writeSkill(workspace, "resources");
      for (const bucket of ["overflow-a", "overflow-b"]) {
        const resourceDir = path.join(dir, bucket);
        mkdirSync(resourceDir, { recursive: true });
        for (let index = 0; index <= MAX_SKILL_DIRECTORY_ENTRIES; index += 1) {
          symlinkSync("missing", path.join(resourceDir, `entry-${String(index).padStart(5, "0")}`));
        }
      }

      expect(enumerateResources(dir, false, warnings)).toEqual([]);
      expect(warnings.warnings.join("")).toContain("resource entry limit");
    } finally {
      cleanup(workspace);
    }
  });

  it("rejects sparse and character-heavy resources before returning their contents", () => {
    const workspace = makeWorkspace();
    try {
      const root = path.join(workspace, "skills");
      const dir = writeSkill(root, "reader", {
        resources: { "references/sparse.txt": "x", "references/chars.txt": "x" },
      });
      const sparse = path.join(dir, "references", "sparse.txt");
      const chars = path.join(dir, "references", "chars.txt");
      truncateSync(sparse, MAX_SKILL_RESOURCE_BYTES + 1);
      writeFileSync(chars, "x".repeat(MAX_SKILL_RESOURCE_CHARS + 1));
      const found = registry(workspace, root);

      for (const rel of ["references/sparse.txt", "references/chars.txt"]) {
        let failure: unknown;
        try {
          found.readResource("reader", rel);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(SkillError);
        expect((failure as SkillError).fields.dimension).toMatch(/bytes|characters/);
      }
    } finally {
      cleanup(workspace);
    }
  });

  it("reads a large text resource incrementally while the legacy whole read stays bounded", () => {
    const workspace = makeWorkspace();
    try {
      const root = path.join(workspace, "skills");
      const dir = writeSkill(root, "paged", {
        resources: { "references/manual.md": "x" },
      });
      const manual = path.join(dir, "references", "manual.md");
      writeFileSync(manual, "a".repeat(MAX_SKILL_RESOURCE_CHARS) + "SECOND PAGE");
      const found = registry(workspace, root);

      expect(() => found.readResource("paged", "references/manual.md")).toThrow(
        /maximum characters/,
      );
      const first = found.readResourceChunk("paged", "references/manual.md");
      expect(first.text).toHaveLength(MAX_SKILL_RESOURCE_CHARS);
      expect(first.nextOffset).toBe(MAX_SKILL_RESOURCE_CHARS);
      const second = found.readResourceChunk("paged", "references/manual.md", first.nextOffset);
      expect(second.text).toBe("SECOND PAGE");
      expect(second.nextOffset).toBeUndefined();
    } finally {
      cleanup(workspace);
    }
  });
});
