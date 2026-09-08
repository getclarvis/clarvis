import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  DIR_MODE,
  MARKETPLACE_FILE,
  writeFileAtomicSync,
  type ConfigurationRoot,
} from "@clarvis/paths";
import { settingsDocumentRevision } from "../config/config-store.ts";
import { kernelSettingsSchema } from "../config/capability-registry.ts";

const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 200;
const CLARVIS_FILES = new Set([
  "settings.json",
  "guard-judge.md",
  "memory-policy.md",
  "CLARVIS.md",
  "AGENTS.md",
]);
const CLARVIS_DIRS = new Set([
  "agents",
  "skills",
  "plugins",
  "workflows",
  "extension-profiles",
  "runtime-recipes",
]);
const SHARED_DIRS = new Set(["skills", "plugins"]);
const PRIVATE_COMPONENT =
  /^(?:keys?|subscriptions?|auth(?:-key)?|credentials?|secrets?|tokens?|workspace-trust)(?:[.-]|$)|^\.env(?:[.-]|$)|\.(?:pem|key|p12|pfx)$/i;

/** Native configuration operations; every mutation requires the revision returned by a read. */
export type ConfigurationFileRequest = {
  operation: "list" | "read" | "write" | "edit" | "delete";
  root: ConfigurationRoot;
  path: string;
  content?: string;
  old_text?: string;
  new_text?: string;
  expected_revision?: string | null;
};

/** Allowed authored configuration paths. Private machine state never enters this vocabulary. */
function allowed(root: ConfigurationRoot, parts: readonly string[]): boolean {
  const head = parts[0];
  if (head === undefined) return true;
  if (parts.some((part) => PRIVATE_COMPONENT.test(part))) return false;
  if (parts.some((part) => [".git", "node_modules", "state", "cache"].includes(part.toLowerCase())))
    return false;
  if (root.endsWith("_agents"))
    return SHARED_DIRS.has(head) || (parts.length === 1 && head === MARKETPLACE_FILE);
  return CLARVIS_DIRS.has(head) || (parts.length === 1 && CLARVIS_FILES.has(head));
}

function pathParts(path: string): string[] {
  if (path === "") return [];
  const parts = path.split("/");
  if (
    path.length > 1024 ||
    /[\\:]/.test(path) ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new Error("Use a relative configuration path without traversal or alternate separators.");
  return parts;
}

/** Check each directory without following links, creating only missing authorized parents. */
function directories(root: string, parts: readonly string[], create: boolean): boolean {
  let current = root;
  for (const [index, part] of [root, ...parts].entries()) {
    if (index > 0) current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return false;
      mkdirSync(current, { mode: DIR_MODE });
      stat = lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Configuration directories must be real directories, not links.");
  }
  return true;
}

/** Descriptor reads reject links, shared inodes, special files, oversized and non-UTF-8 data. */
function readDocument(file: string): { content: string; revision: string } | null {
  let before;
  try {
    before = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES)
    throw new Error("Only bounded regular configuration files with one link are accessible.");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev
    )
      throw new Error("Configuration file changed while opening it.");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size);
      if (count === 0) break;
      size += count;
    }
    if (size > MAX_BYTES) throw new Error("Configuration file exceeds the size limit.");
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, size),
    );
    return { content, revision: settingsDocumentRevision(bytes.subarray(0, size)) };
  } finally {
    closeSync(fd);
  }
}

/**
 * Mediated host file access used only after native configuration consent.
 * Rechecks reject stable link escapes; parent replacement by another process remains the
 * documented portable-filesystem TOCTOU limitation. This is not an OS sandbox.
 */
export function configurationFileOperation(
  roots: Readonly<Record<ConfigurationRoot, string>>,
  request: ConfigurationFileRequest,
): unknown {
  if (!Object.hasOwn(roots, request.root)) throw new Error("Unknown configuration root.");
  const parts = pathParts(request.path);
  if (!allowed(request.root, parts))
    throw new Error("This path is outside authored configuration access.");
  const root = roots[request.root];
  if (request.operation === "list") {
    if (!directories(root, parts, false)) return { entries: [], missing: true };
    const entries = readdirSync(join(root, ...parts), { withFileTypes: true })
      .filter((entry) => allowed(request.root, [...parts, entry.name]) && !entry.isSymbolicLink())
      .filter((entry) => entry.isFile() || entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      entries: entries.slice(0, MAX_ENTRIES).map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : "file",
      })),
      truncated: entries.length > MAX_ENTRIES,
    };
  }
  if (parts.length === 0) throw new Error("Choose a configuration file, not its root.");
  const parents = parts.slice(0, -1);
  const parentExists = directories(root, parents, false);
  const file = join(root, ...parts);
  const current = parentExists ? readDocument(file) : null;
  if (request.operation === "read") return current ?? { content: null, revision: null };
  if (
    request.operation !== "write" &&
    request.operation !== "edit" &&
    request.operation !== "delete"
  )
    throw new Error("Unknown configuration operation.");
  if (
    request.expected_revision === undefined ||
    request.expected_revision !== (current?.revision ?? null)
  )
    throw new Error("Configuration revision conflict. Read the file again before changing it.");
  if (request.operation === "delete") {
    if (current === null) throw new Error("Configuration file does not exist.");
    directories(root, parents, false);
    unlinkSync(file);
    return { deleted: true };
  }
  let content = request.content;
  if (request.operation === "edit") {
    if (current === null) throw new Error("Read an existing file before editing it.");
    const { old_text: oldText, new_text: newText } = request;
    if (typeof oldText !== "string" || oldText.length === 0 || typeof newText !== "string")
      throw new Error("An edit requires nonempty old_text and a new_text replacement.");
    const index = current.content.indexOf(oldText);
    if (index < 0 || current.content.indexOf(oldText, index + 1) >= 0)
      throw new Error("old_text must match exactly once. Include more surrounding context.");
    content =
      current.content.slice(0, index) + newText + current.content.slice(index + oldText.length);
  }
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_BYTES)
    throw new Error("Provide UTF-8 configuration content within the size limit.");
  if (parts.length === 1 && parts[0] === "settings.json") {
    try {
      kernelSettingsSchema.parse(JSON.parse(content));
    } catch {
      throw new Error("settings.json must be valid JSON satisfying Clarvis settings schema.");
    }
  }
  directories(root, parents, true);
  writeFileAtomicSync(file, content);
  return { written: true, revision: settingsDocumentRevision(content) };
}
