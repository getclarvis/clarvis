import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { DIR_MODE, FILE_MODE } from "@clarvis/paths";
import { NOOP_LOGGER } from "@clarvis/capability";
import type { SkillContent } from "./types.ts";
import { readBoundedText, readBoundedTextChunk } from "./bounded-read.ts";
import {
  MAX_SKILL_EXECUTION_SNAPSHOT_BYTES,
  MAX_SKILL_RESOURCE_BYTES,
  MAX_SKILL_RESOURCE_CHARS,
  MAX_SKILL_RESOURCE_FILE_BYTES,
  MAX_SKILL_RESOURCE_SNAPSHOT_BYTES,
} from "./limits.ts";

/** Copy only confined regular single-link files under a fixed allocation limit. */
function captureBytes(file: string, root: string, limit: number) {
  const rel = relative(realpathSync(root), realpathSync(file));
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\"))
    throw new Error("Skill snapshot resource escapes its package.");
  const descriptor = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
      throw new Error("Skill snapshot requires bounded regular single-link files.");
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(descriptor, buffer, size, buffer.length - size, size);
      if (!count) break;
      size += count;
    }
    if (size !== stat.size) throw new Error("Skill resource changed during capture.");
    return { bytes: buffer.subarray(0, size), mode: FILE_MODE | (stat.mode & 0o100) };
  } finally {
    closeSync(descriptor);
  }
}

/** Materialize one bounded catalog revision so helpers and resource reads share the captured bytes. */
export function captureSkillExecution(skills: readonly SkillContent[]) {
  const root = mkdtempSync(join(tmpdir(), "clarvis-skills-"));
  const contents = new Map<string, SkillContent>();
  const files = new Map<string, Map<string, string>>();
  let total = 0;
  try {
    for (const [index, skill] of skills.entries()) {
      const dir = join(root, String(index));
      mkdirSync(dir, { mode: DIR_MODE });
      const resources = new Map<string, string>();
      let skillBytes = 0;
      for (const resource of skill.resources) {
        const parts = resource.rel.split("/");
        if (parts.some((part) => !part || part === "." || part === ".." || /[\\:]/.test(part)))
          throw new Error("Invalid skill resource snapshot path.");
        const { bytes, mode } = captureBytes(
          resource.path,
          skill.dir,
          MAX_SKILL_RESOURCE_FILE_BYTES,
        );
        skillBytes += bytes.length;
        total += bytes.length;
        if (
          skillBytes > MAX_SKILL_RESOURCE_SNAPSHOT_BYTES ||
          total > MAX_SKILL_EXECUTION_SNAPSHOT_BYTES
        )
          throw new Error("Skill execution snapshot exceeds its byte budget.");
        const path = join(dir, ...parts);
        mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
        writeFileSync(path, bytes, { mode });
        resources.set(resource.rel, path);
      }
      const path = join(dir, "SKILL.md");
      const { bytes: manifest } = captureBytes(skill.path, skill.dir, MAX_SKILL_RESOURCE_BYTES);
      total += manifest.length;
      if (total > MAX_SKILL_EXECUTION_SNAPSHOT_BYTES)
        throw new Error("Skill execution snapshot exceeds its byte budget.");
      writeFileSync(path, manifest, { mode: FILE_MODE });
      contents.set(skill.name, {
        ...skill,
        dir,
        path,
        ...(skill.executionRoot === undefined ? {} : { executionRoot: dir }),
        resources: skill.resources.map((resource) => ({
          ...resource,
          path: resources.get(resource.rel)!,
        })),
      });
      files.set(skill.name, resources);
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const read = (name: string, rel: string, offset = 0, maxChars = MAX_SKILL_RESOURCE_CHARS) => {
    const path = files.get(name)?.get(rel);
    if (path === undefined) throw new Error("Resource is outside the captured skill revision.");
    return readBoundedTextChunk(path, {
      offset,
      maxChars: Math.min(maxChars, MAX_SKILL_RESOURCE_CHARS),
      maxBytes: MAX_SKILL_RESOURCE_BYTES,
      maxFileBytes: MAX_SKILL_RESOURCE_FILE_BYTES,
      code: "invalid_input",
      label: "captured skill resource",
      logger: NOOP_LOGGER,
    });
  };
  return {
    contents,
    readResource(name: string, rel: string) {
      const path = files.get(name)?.get(rel);
      if (path === undefined) throw new Error("Resource is outside the captured skill revision.");
      return readBoundedText(path, {
        maxBytes: MAX_SKILL_RESOURCE_BYTES,
        maxChars: MAX_SKILL_RESOURCE_CHARS,
        code: "invalid_input",
        label: "captured skill resource",
        logger: NOOP_LOGGER,
      });
    },
    readResourceChunk: read,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
