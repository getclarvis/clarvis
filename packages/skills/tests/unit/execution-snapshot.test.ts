import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureSkillExecution,
  listSkillDirs,
  validateSkillDocument,
  createAgentSkills,
} from "../../src/index.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

it("pins resource reads and executable helpers to the same bytes after source authoring", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-snapshot-test-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "review");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\nname: review\ndescription: Review tests\n---\nReview.\n",
  );
  const helper = join(dir, "check.sh");
  writeFileSync(helper, "echo first\n", { mode: 0o700 });
  const provider = createAgentSkills({
    workspace: root,
    roots: [{ path: root, executionRoot: root }],
  });
  const snapshot = captureSkillExecution([provider.loadSkill("review")!]);
  cleanup.push(snapshot.close);
  writeFileSync(helper, "echo second\n");
  const captured = snapshot.contents.get("review")!;
  expect(captured.executionRoot).not.toBe(dir);
  expect(snapshot.readResourceChunk("review", "check.sh").text).toBe("echo first\n");
  expect(readFileSync(join(captured.executionRoot!, "check.sh"), "utf8")).toBe("echo first\n");
  expect(() => snapshot.readResourceChunk("review", "../check.sh")).toThrow();
});

it("preserves full-read limits while allowing bounded resource pagination", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-snapshot-limits-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "review");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\nname: review\ndescription: Review tests\n---\nReview.\n",
  );
  writeFileSync(join(dir, "reference.md"), "x".repeat(300 * 1024));
  const provider = createAgentSkills({ workspace: root, roots: [{ path: root }] });
  const snapshot = captureSkillExecution([provider.loadSkill("review")!]);
  cleanup.push(snapshot.close);
  expect(() => provider.readResource("review", "reference.md")).toThrow();
  expect(() => snapshot.readResource("review", "reference.md")).toThrow();
  expect(snapshot.readResourceChunk("review", "reference.md", 0, 12)).toMatchObject({
    text: "x".repeat(12),
    nextOffset: 12,
    totalBytes: 300 * 1024,
  });
});

it("allows several per-skill snapshots within the global execution budget", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-snapshot-global-limit-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const skills = [];
  for (let index = 0; index < 5; index++) {
    const dir = join(root, `skill-${index}`);
    mkdirSync(dir);
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: skill-${index}\ndescription: Snapshot test\n---\nSkill.\n`,
    );
    writeFileSync(join(dir, "reference.bin"), Buffer.alloc(7 * 1024 * 1024, index));
    const provider = createAgentSkills({ workspace: root, roots: [{ path: root }] });
    skills.push(provider.loadSkill(`skill-${index}`)!);
  }
  const snapshot = captureSkillExecution(skills);
  cleanup.push(snapshot.close);
  expect(snapshot.contents).toHaveLength(5);
});

it("validates prospective documents with the same root-specific discovery policy", () => {
  const directory = join(tmpdir(), "review");
  expect(validateSkillDocument("Review tests.", { directory }).name).toBe("review");
  expect(() =>
    validateSkillDocument("Review tests.", { directory, validation: "agent-skills" }),
  ).toThrow("requires");
  expect(
    validateSkillDocument("---\nname: review\ndescription: Review tests\n---\nReview.", {
      directory,
      validation: "agent-skills",
    }).name,
  ).toBe("review");
});

it("observes empty discovery directories without descending into skill resources", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-watch-discovery-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "empty"));
  mkdirSync(join(root, "review", "resources"), { recursive: true });
  writeFileSync(join(root, "review", "SKILL.md"), "Review.");
  const observed: string[] = [];
  expect(
    listSkillDirs(root, false, undefined, undefined, {
      observeDirectory: (path) => observed.push(path),
    }),
  ).toHaveLength(1);
  expect(observed.sort()).toEqual([root, join(root, "empty"), join(root, "review")].sort());
});

it("rejects a resource removed after discovery instead of returning a partial execution catalog", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-snapshot-missing-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "review");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\nname: review\ndescription: Review tests\n---\nReview.\n",
  );
  const resource = join(dir, "reference.md");
  writeFileSync(resource, "Original reference.");
  const provider = createAgentSkills({ workspace: root, roots: [{ path: root }] });
  const skill = provider.loadSkill("review")!;
  expect(skill.resources.map((entry) => entry.rel)).toContain("reference.md");
  rmSync(resource);
  expect(() => captureSkillExecution([skill])).toThrow();
  writeFileSync(resource, "Restored reference.");
  const snapshot = captureSkillExecution([skill]);
  cleanup.push(snapshot.close);
  expect(snapshot.readResource("review", "reference.md")).toBe("Restored reference.");
});
