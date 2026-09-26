import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  publishSystemDocs,
  reconcileSystemDocs,
  SYSTEM_DOCS_FILES,
  systemDocsDestination,
  systemDocsSourceForModule,
} from "../../src/skills/system-docs.ts";
import { createSystemDocsProvider } from "../../src/skills/system-docs-provider.ts";
import { NOOP_LOGGER } from "@clarvis/capability";

const asset = fileURLToPath(new URL("../../assets/skills/.system/clarvis-docs/", import.meta.url));

test("publishes and refreshes one owned system skill under an injected global root", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-system-docs-"));
  const globalDir = join(root, "alternate-global");
  const sourceDir = join(root, "source");
  try {
    await cp(asset, sourceDir, { recursive: true });
    const input = { globalDir, sourceDir, revision: "initial" };
    expect(await publishSystemDocs(input)).toBe("published");
    const target = systemDocsDestination(globalDir);
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe(
      await readFile(join(sourceDir, "SKILL.md"), "utf8"),
    );
    expect(await publishSystemDocs(input)).toBe("unchanged");
    const resource = join(sourceDir, "references", "paths.md");
    await writeFile(resource, `${await readFile(resource, "utf8")}\nRevision changed.\n`);
    expect(await publishSystemDocs({ ...input, revision: "changed" })).toBe("published");
    expect(await readFile(join(target, "references", "paths.md"), "utf8")).toContain(
      "Revision changed.",
    );
    await mkdir(join(globalDir, "skills", "ordinary"));
    await writeFile(join(globalDir, "skills", "ordinary", "SKILL.md"), "keep");
    expect(await publishSystemDocs({ globalDir, revision: "older" })).toBe("retired");
    expect(await readFile(join(globalDir, "skills", "ordinary", "SKILL.md"), "utf8")).toBe("keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parallel starts publish one complete revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-system-docs-parallel-"));
  try {
    const globalDir = join(root, "global");
    const outcomes = await Promise.all([
      publishSystemDocs({ sourceDir: asset, globalDir, revision: "current" }),
      publishSystemDocs({ sourceDir: asset, globalDir, revision: "current" }),
    ]);
    expect(outcomes.sort()).toEqual(["published", "unchanged"]);
    expect(await readFile(join(systemDocsDestination(globalDir), "SKILL.md"), "utf8")).toBe(
      await readFile(join(asset, "SKILL.md"), "utf8"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package asset lookup handles source and emitted modules; Code bundle origin is explicit", () => {
  const sourceUrl = new URL("../../src/skills/system-docs.ts", import.meta.url).href;
  expect(systemDocsSourceForModule(sourceUrl)).toBe(resolve(asset));
  const emittedUrl = new URL("../../dist/skills/system-docs.js", import.meta.url).href;
  expect(systemDocsSourceForModule(emittedUrl)).toBe(resolve(asset));
  const bundledUrl = new URL("../../../code/dist/index.js", import.meta.url).href;
  expect(() => systemDocsSourceForModule(bundledUrl)).toThrow("explicit product asset root");
});

test("kernel startup verifies its own release assets before publishing or retiring them", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-system-docs-release-"));
  const release = join(root, "release");
  const globalDir = join(root, "global");
  const sourceDir = join(release, "packages/kernel/assets/skills/.system/clarvis-docs");
  try {
    await cp(asset, sourceDir, { recursive: true });
    const files = await Promise.all(
      SYSTEM_DOCS_FILES.map(async (name) => ({
        path: `packages/kernel/assets/skills/.system/clarvis-docs/${name}`,
        sha256: createHash("sha256")
          .update(await readFile(join(sourceDir, name)))
          .digest("hex"),
      })),
    );
    await writeFile(join(release, "release.json"), JSON.stringify({ version: "current", files }));
    expect(await reconcileSystemDocs(globalDir, release)).toBe("published");
    expect(await reconcileSystemDocs(globalDir, release)).toBe("unchanged");
    expect(await readFile(join(systemDocsDestination(globalDir), "SKILL.md"), "utf8")).toBe(
      await readFile(join(asset, "SKILL.md"), "utf8"),
    );

    await writeFile(join(sourceDir, "references/paths.md"), "altered");
    await expect(reconcileSystemDocs(globalDir, release)).rejects.toThrow("release file changed");
    for (const malformed of [
      "[]",
      "{}",
      JSON.stringify({
        version: "current",
        files: files.map((file, index) => (index === 0 ? { ...file, sha256: "invalid" } : file)),
      }),
      "x".repeat(1024 * 1024 + 1),
    ]) {
      await writeFile(join(release, "release.json"), malformed);
      await expect(reconcileSystemDocs(globalDir, release)).rejects.toThrow();
      expect(await readFile(join(systemDocsDestination(globalDir), "SKILL.md"), "utf8")).toBe(
        await readFile(join(asset, "SKILL.md"), "utf8"),
      );
    }
    await rm(join(release, "release.json"));
    await mkdir(join(release, "release.json"));
    await expect(reconcileSystemDocs(globalDir, release)).rejects.toThrow(
      "manifest is not a regular file",
    );
    await rm(join(release, "release.json"), { recursive: true });
    await writeFile(join(release, "release.json"), JSON.stringify({ version: "older", files: [] }));
    expect(await reconcileSystemDocs(globalDir, release)).toBe("retired");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verified installed skill loads its bundled reference without a repository path", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-system-docs-provider-"));
  try {
    const globalDir = join(root, "global");
    await publishSystemDocs({ sourceDir: asset, globalDir, revision: "current" });
    const captured = createSystemDocsProvider(globalDir, NOOP_LOGGER);
    try {
      expect(captured.provider.listSkills().map((skill) => skill.name)).toEqual(["clarvis-docs"]);
      const body = captured.provider.loadSkill("clarvis-docs");
      expect(body?.body).toContain("references/settings.md");
      expect(captured.provider.readResource("clarvis-docs", "references/paths.md")).toContain(
        "CLARVIS_HOME",
      );
      expect(() => captured.provider.readResource("clarvis-docs", "../SKILL.md")).toThrow();
      expect(() => captured.provider.readResource("ordinary", "references/paths.md")).toThrow();
      expect(body?.executionRoot).toBeUndefined();
    } finally {
      captured.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a damaged installed skill cannot be attested as product documentation", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-system-docs-attestation-"));
  try {
    const globalDir = join(root, "global");
    await publishSystemDocs({ sourceDir: asset, globalDir, revision: "current" });
    await writeFile(
      join(systemDocsDestination(globalDir), "SKILL.md"),
      "---\nname: foreign\ndescription: Foreign skill\n---\n",
    );
    expect(() => createSystemDocsProvider(globalDir, NOOP_LOGGER)).toThrow(
      "must match directory 'clarvis-docs'",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a malformed source before creating any managed destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-system-docs-invalid-"));
  try {
    const globalDir = join(root, "global");
    const sourceDir = join(root, "source");
    await cp(asset, sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), "---\nname: imposter\n---\nUntrusted body.\n");
    await expect(publishSystemDocs({ sourceDir, globalDir, revision: "invalid" })).rejects.toThrow(
      "frontmatter is invalid",
    );
    await expect(
      readFile(join(systemDocsDestination(globalDir), "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects damaged owned content and incomplete source without replacing either", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-system-docs-damage-"));
  const globalDir = join(root, "global");
  const sourceDir = join(root, "source");
  try {
    await cp(asset, sourceDir, { recursive: true });
    expect(await publishSystemDocs({ sourceDir, globalDir, revision: "current" })).toBe(
      "published",
    );
    const target = systemDocsDestination(globalDir);
    const marker = join(target, ".clarvis-docs-owner.json");
    const originalMarker = await readFile(marker);
    for (const invalid of ["{", "{}"]) {
      await writeFile(marker, invalid);
      await expect(
        publishSystemDocs({ sourceDir, globalDir, revision: "current" }),
      ).rejects.toThrow("ownership marker is invalid");
    }
    await writeFile(marker, originalMarker);

    const unexpected = join(target, "unexpected.txt");
    await writeFile(unexpected, "user data");
    await expect(publishSystemDocs({ sourceDir, globalDir, revision: "current" })).rejects.toThrow(
      "unexpected entries",
    );
    expect(await readFile(unexpected, "utf8")).toBe("user data");
    await rm(unexpected);
    const extraReference = join(target, "references", "unexpected.md");
    await writeFile(extraReference, "user data");
    await expect(publishSystemDocs({ sourceDir, globalDir, revision: "current" })).rejects.toThrow(
      "unexpected resources",
    );
    await rm(extraReference);

    await expect(
      publishSystemDocs({ sourceDir: join(root, "missing"), globalDir, revision: "next" }),
    ).rejects.toThrow("source is absent");
    await rm(join(sourceDir, "references"), { recursive: true });
    await expect(publishSystemDocs({ sourceDir, globalDir, revision: "next" })).rejects.toThrow(
      "source references are absent",
    );
    await cp(join(asset, "references"), join(sourceDir, "references"), { recursive: true });
    await writeFile(join(sourceDir, "references/paths.md"), "");
    await expect(publishSystemDocs({ sourceDir, globalDir, revision: "next" })).rejects.toThrow(
      "source size is invalid",
    );
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe(
      await readFile(join(asset, "SKILL.md"), "utf8"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an active provider keeps its captured resource after a new revision is published", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-system-docs-snapshot-"));
  try {
    const globalDir = join(root, "global");
    const sourceDir = join(root, "source");
    await cp(asset, sourceDir, { recursive: true });
    await publishSystemDocs({ sourceDir, globalDir, revision: "first" });
    const first = createSystemDocsProvider(globalDir, NOOP_LOGGER);
    try {
      const path = "references/paths.md";
      const previous = first.provider.readResource("clarvis-docs", path);
      await writeFile(join(sourceDir, path), `${previous}\nNext revision.\n`);
      await publishSystemDocs({ sourceDir, globalDir, revision: "second" });
      const second = createSystemDocsProvider(globalDir, NOOP_LOGGER);
      try {
        expect(first.provider.readResource("clarvis-docs", path)).toBe(previous);
        expect(second.provider.readResource("clarvis-docs", path)).toContain("Next revision.");
      } finally {
        second.close();
      }
    } finally {
      first.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses an unowned target or a symlinked system parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-system-docs-boundary-"));
  try {
    const globalDir = join(root, "global");
    const target = systemDocsDestination(globalDir);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "keep.txt"), "user-owned");
    await expect(
      publishSystemDocs({ sourceDir: asset, globalDir, revision: "current" }),
    ).rejects.toThrow("unowned system skill");
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("user-owned");

    await rm(target, { recursive: true });
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "outside");
    await symlink(outside, target);
    await expect(
      publishSystemDocs({ sourceDir: asset, globalDir, revision: "current" }),
    ).rejects.toThrow("not a regular directory");
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("outside");

    const linkedGlobal = join(root, "linked-global");
    await mkdir(dirname(linkedGlobal), { recursive: true });
    await symlink(globalDir, linkedGlobal);
    await expect(
      publishSystemDocs({ sourceDir: asset, globalDir: linkedGlobal, revision: "current" }),
    ).rejects.toThrow("not a regular directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restarts after an interrupted staging directory without exposing partial content", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-system-docs-interrupted-"));
  try {
    const globalDir = join(root, "global");
    const parent = dirname(systemDocsDestination(globalDir));
    const interrupted = join(parent, ".clarvis-docs.stage-interrupted");
    await mkdir(interrupted, { recursive: true });
    await writeFile(join(interrupted, "SKILL.md"), "partial");
    expect(await publishSystemDocs({ sourceDir: asset, globalDir, revision: "current" })).toBe(
      "published",
    );
    const provider = createSystemDocsProvider(globalDir, NOOP_LOGGER);
    try {
      expect(provider.provider.listSkills().map((skill) => skill.name)).toEqual(["clarvis-docs"]);
      expect(provider.provider.loadSkill("clarvis-docs")?.body).not.toBe("partial");
    } finally {
      provider.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
