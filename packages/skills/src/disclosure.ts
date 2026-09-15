import type { SkillContent, SkillResource } from "./types.ts";
import type { SkillsProvider } from "./tool.ts";
import { READ_SKILL_RESOURCE_TOOL_NAME, SKILL_RESOURCE_MAX_CHARS } from "./tool.ts";
import { MAX_SKILL_RESOURCE_FILE_BYTES } from "./limits.ts";

/**
 * Render the trailing "Bundled resources" hint listing a skill's resources and
 * how to fetch one; empty when the skill bundles none.
 */
function renderResourceList(resources: readonly Pick<SkillResource, "rel" | "kind">[]): string {
  if (resources.length === 0) return "";
  const lines = resources.map((r) => `- ${r.rel} (${r.kind})`).join("\n");
  return (
    `\n\nBundled resources (call ${READ_SKILL_RESOURCE_TOOL_NAME} with name, the exact ` +
    `resource path, and offset=0):\n${lines}`
  );
}

/** Validate byte cursors, decoded bounds and continuation progress from a resource provider. */
export function validateResourceChunk(
  chunk: ReturnType<NonNullable<SkillsProvider["readResourceChunk"]>>,
  requestedOffset: number,
  maxChars: number,
): string | undefined {
  if (!Number.isSafeInteger(chunk.offset) || chunk.offset !== requestedOffset) {
    return "provider returned a mismatched resource offset";
  }
  if (
    !Number.isSafeInteger(chunk.totalBytes) ||
    chunk.totalBytes < 0 ||
    chunk.totalBytes > MAX_SKILL_RESOURCE_FILE_BYTES ||
    chunk.offset > chunk.totalBytes
  ) {
    return "provider returned an invalid resource size";
  }
  if (chunk.text.length > maxChars) return "provider exceeded the resource character bound";
  const decodedEnd = chunk.offset + Buffer.byteLength(chunk.text, "utf8");
  if (decodedEnd > chunk.totalBytes) return "provider returned text past the resource size";
  if (chunk.nextOffset !== undefined) {
    if (
      !Number.isSafeInteger(chunk.nextOffset) ||
      chunk.nextOffset <= chunk.offset ||
      chunk.nextOffset > chunk.totalBytes
    ) {
      return "provider returned an invalid resource continuation offset";
    }
    if (chunk.nextOffset !== decodedEnd) {
      return "provider returned a continuation offset that does not match its text";
    }
    if (decodedEnd === chunk.totalBytes) {
      return "provider returned a redundant continuation offset at the resource end";
    }
  } else if (decodedEnd !== chunk.totalBytes) {
    return "provider omitted a required resource continuation offset";
  }
  return undefined;
}

/** Render admitted skill metadata consistently for native and remote disclosure. */
export function formatSkillBody(
  content: Pick<
    SkillContent,
    "name" | "description" | "body" | "source" | "dir" | "executionRoot" | "resourceAccess"
  > & { resources: readonly Pick<SkillResource, "rel" | "kind">[] },
): string {
  const body = content.body.length > 0 ? content.body : "(this skill has an empty body)";
  const executionHint =
    content.executionRoot === undefined ||
    content.resourceAccess === "remote" ||
    content.source === "builtin"
      ? ""
      : `Package execution root: ${content.executionRoot}\n` +
        "Run bundled helpers through the normal shell tool so its command guard applies. " +
        "When a native sandbox is active, the package root is mounted read-only.\n";
  return (
    `Skill '${content.name}' — ${content.description}\n\n` +
    (content.source === "builtin"
      ? "Builtin instructions embedded in Clarvis; no skill file or execution directory.\n"
      : content.resourceAccess === "remote"
        ? "Remote skill instructions; no skill file or directory is mounted in this runtime.\n" +
          `Read bundled paths with ${READ_SKILL_RESOURCE_TOOL_NAME}, using the skill name, resource path and offset=0.\n` +
          "Before executing a bundled helper, read all required resource pages and prepare the files " +
          "and their relative directory structure in a writable workspace directory. Use the normal " +
          "shell tool with its grants and command guard. Remote resource names are not filesystem paths.\n"
        : `Skill directory: ${content.dir}\n` +
          "Resolve bundled relative paths from that directory.\n") +
    executionHint +
    "\n" +
    `${body}${renderResourceList(content.resources)}`
  );
}

/** Validate and render one byte-addressed resource page; invalid provider pages throw. */
export function formatSkillResourceChunk(
  name: string,
  resource: string,
  chunk: ReturnType<NonNullable<SkillsProvider["readResourceChunk"]>>,
  requestedOffset: number,
  maxChars = SKILL_RESOURCE_MAX_CHARS,
): string {
  const invalid = validateResourceChunk(chunk, requestedOffset, maxChars);
  if (invalid !== undefined) throw new Error(invalid);
  const continuation =
    chunk.nextOffset === undefined
      ? ""
      : `\n\n[resource continues; call ${READ_SKILL_RESOURCE_TOOL_NAME} with the same name ` +
        `and resource and offset=${String(chunk.nextOffset)}]`;
  return `Resource '${resource}' of skill '${name}' (bytes ${String(chunk.offset)}-${String(
    chunk.nextOffset ?? chunk.totalBytes,
  )} of ${String(chunk.totalBytes)}):\n\n${chunk.text}${continuation}`;
}

/** Render a bounded whole-resource read without advertising an unsupported continuation. */
export function formatSkillResourceLegacy(
  name: string,
  resource: string,
  text: string,
  maxChars = SKILL_RESOURCE_MAX_CHARS,
): string {
  const end = Math.min(maxChars, text.length);
  const continuation =
    end < text.length
      ? "\n\n[resource truncated; this provider does not support byte-offset continuation]"
      : "";
  return `Resource '${resource}' of skill '${name}' (characters 0-${String(end)} of ${String(
    text.length,
  )}):\n\n${text.slice(0, end)}${continuation}`;
}
