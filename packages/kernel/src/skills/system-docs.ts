import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireLocalLease, globalPaths } from "@clarvis/paths";

/** The sole product-owned system skill name and its bounded raw Markdown tree. */
export const SYSTEM_DOCS_NAME = "clarvis-docs";

/** Files published as one revision; unexpected source files are ignored. */
export const SYSTEM_DOCS_FILES = [
  "SKILL.md",
  "references/authority.md",
  "references/extensions.md",
  "references/paths.md",
  "references/settings.md",
  "references/troubleshooting.md",
] as const;

const OWNER_FILE = ".clarvis-docs-owner.json";
const OWNER_KIND = "clarvis.system-skill.v1";
const MAX_FILE_BYTES = 50_000;

interface OwnedRevision {
  kind: typeof OWNER_KIND;
  name: typeof SYSTEM_DOCS_NAME;
  digest: string;
  revision: string;
}

/** A verified source tree or a retirement request for a pre-skill release. */
export interface SystemDocsPublication {
  sourceDir?: string;
  globalDir?: string;
  revision: string;
}

/** Resolve the destination through the same Clarvis global root used by settings. */
export function systemDocsDestination(globalDir?: string): string {
  return join(globalPaths(globalDir).skillsDir, ".system", SYSTEM_DOCS_NAME);
}

async function regular(path: string): Promise<boolean> {
  const status = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return status?.isFile() === true && !status.isSymbolicLink();
}

async function directory(path: string): Promise<"absent" | "directory"> {
  const status = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (status === undefined) return "absent";
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`system skill path is not a regular directory: ${path}`);
  }
  return "directory";
}

async function secureDirectoryTree(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if ((await directory(current)) === "absent") {
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      await directory(current);
    }
  }
}

async function ownedRevision(path: string): Promise<OwnedRevision | undefined> {
  if ((await directory(path)) === "absent") return undefined;
  const marker = join(path, OWNER_FILE);
  if (!(await regular(marker)))
    throw new Error(`refusing to replace unowned system skill: ${path}`);
  const bytes = await readFile(marker);
  if (bytes.byteLength > 4096) throw new Error(`system skill ownership marker is invalid: ${path}`);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`system skill ownership marker is invalid: ${path}`);
  }
  const record = value as Partial<OwnedRevision>;
  if (
    record?.kind !== OWNER_KIND ||
    record.name !== SYSTEM_DOCS_NAME ||
    typeof record.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.digest) ||
    typeof record.revision !== "string" ||
    record.revision.length === 0 ||
    record.revision.length > 128
  ) {
    throw new Error(`system skill ownership marker is invalid: ${path}`);
  }
  return record as OwnedRevision;
}

async function sourceFiles(sourceDir: string): Promise<Map<string, Uint8Array>> {
  if ((await directory(sourceDir)) === "absent") {
    throw new Error(`system skill source is absent: ${sourceDir}`);
  }
  const files = new Map<string, Uint8Array>();
  if ((await directory(join(sourceDir, "references"))) === "absent") {
    throw new Error("system skill source references are absent");
  }
  for (const relative of SYSTEM_DOCS_FILES) {
    const path = join(sourceDir, relative);
    if (!(await regular(path))) throw new Error(`system skill source is incomplete: ${relative}`);
    const bytes = await readFile(path);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error(`system skill source size is invalid: ${relative}`);
    }
    files.set(relative, bytes);
  }
  const manifest = new TextDecoder("utf-8", { fatal: true }).decode(files.get("SKILL.md"));
  const frontmatter = manifest.startsWith("---\n")
    ? manifest.slice(4, manifest.indexOf("\n---\n", 4)).split("\n")
    : [];
  if (
    !frontmatter.includes(`name: ${SYSTEM_DOCS_NAME}`) ||
    !frontmatter.includes("user-invocable: false")
  ) {
    throw new Error("system skill source frontmatter is invalid");
  }
  for (const bytes of files.values()) new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return files;
}

async function installedMatches(path: string, expectedDigest: string): Promise<boolean> {
  const expectedTop = [OWNER_FILE, "SKILL.md", "references"].sort();
  if (JSON.stringify((await readdir(path)).sort()) !== JSON.stringify(expectedTop)) {
    throw new Error(`owned system skill contains unexpected entries: ${path}`);
  }
  const references = join(path, "references");
  await directory(references);
  const expectedReferences = SYSTEM_DOCS_FILES.filter((name) => name.startsWith("references/"))
    .map((name) => name.slice("references/".length))
    .sort();
  if (JSON.stringify((await readdir(references)).sort()) !== JSON.stringify(expectedReferences)) {
    throw new Error(`owned system skill contains unexpected resources: ${path}`);
  }
  const files = await sourceFiles(path).catch(() => undefined);
  return files !== undefined && digestFiles(files) === expectedDigest;
}

function digestFiles(files: ReadonlyMap<string, Uint8Array>): string {
  const hash = createHash("sha256");
  for (const [path, bytes] of files) {
    hash.update(path);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function writeStage(
  parent: string,
  files: ReadonlyMap<string, Uint8Array>,
  owner: OwnedRevision,
): Promise<string> {
  const stage = join(parent, `.clarvis-docs.stage-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    await mkdir(join(stage, "references"), { mode: 0o700 });
    for (const [relative, bytes] of files) {
      await writeFile(join(stage, relative), bytes, { flag: "wx", mode: 0o600 });
    }
    await writeFile(join(stage, OWNER_FILE), `${JSON.stringify(owner)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return stage;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

/** Publish one complete owned revision under a lease, or retire an owned newer copy. */
export async function publishSystemDocs(
  input: SystemDocsPublication,
): Promise<"unchanged" | "published" | "retired"> {
  const target = systemDocsDestination(input.globalDir);
  const parent = dirname(target);
  if (input.sourceDir === undefined && (await directory(parent)) === "absent") return "unchanged";
  await secureDirectoryTree(parent);
  const lease = await acquireLocalLease(join(parent, ".clarvis-docs.lock"), {
    staleMs: 120_000,
    waitMs: 5_000,
    heartbeatMs: 30_000,
  });
  if (lease === null) throw new Error("system skill publication is busy");
  try {
    const current = await ownedRevision(target);
    if (current !== undefined) await installedMatches(target, current.digest);
    if (input.sourceDir === undefined) {
      if (current === undefined) return "unchanged";
      await lease.assertOwned();
      const retired = join(parent, `.clarvis-docs.retired-${randomUUID()}`);
      await rename(target, retired);
      await rm(retired, { recursive: true });
      return "retired";
    }
    const files = await sourceFiles(input.sourceDir);
    const digest = digestFiles(files);
    if (
      current?.digest === digest &&
      current.revision === input.revision &&
      (await installedMatches(target, current.digest))
    )
      return "unchanged";
    const stage = await writeStage(parent, files, {
      kind: OWNER_KIND,
      name: SYSTEM_DOCS_NAME,
      digest,
      revision: input.revision,
    });
    const backup = join(parent, `.clarvis-docs.backup-${randomUUID()}`);
    let moved = false;
    try {
      await lease.assertOwned();
      if (current !== undefined) {
        await rename(target, backup);
        moved = true;
      }
      await rename(stage, target);
    } catch (error) {
      if (moved && (await directory(target)) === "absent") await rename(backup, target);
      throw error;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
    if (moved) await rm(backup, { recursive: true });
    return "published";
  } finally {
    await lease.release();
  }
}

/** Resolve the product root from a package-owned module; bundles pass it explicitly. */
function projectRootForModule(moduleUrl: string): string {
  const modulePath = fileURLToPath(moduleUrl);
  const directory = dirname(modulePath);
  const packageRoot = dirname(dirname(directory));
  if (
    basename(directory) === "skills" &&
    basename(packageRoot) === "kernel" &&
    basename(dirname(packageRoot)) === "packages"
  ) {
    return dirname(dirname(packageRoot));
  }
  throw new Error("bundled kernels require an explicit product asset root");
}

/** Locate the maintained asset beside a module in its own Kernel package. */
export function systemDocsSourceForModule(moduleUrl: string): string {
  return join(
    projectRootForModule(moduleUrl),
    "packages",
    "kernel",
    "assets",
    "skills",
    ".system",
    SYSTEM_DOCS_NAME,
  );
}

/** Reconcile the copy for this module's own source tree or verified portable release. */
export async function reconcileSystemDocs(
  globalDir?: string,
  sourceRoot?: string,
): Promise<"unchanged" | "published" | "retired"> {
  const releaseRoot =
    sourceRoot === undefined ? projectRootForModule(import.meta.url) : resolve(sourceRoot);
  const sourceDir = join(
    releaseRoot,
    "packages",
    "kernel",
    "assets",
    "skills",
    ".system",
    SYSTEM_DOCS_NAME,
  );
  const manifestPath = join(releaseRoot, "release.json");
  const manifestStatus = await lstat(manifestPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (manifestStatus !== undefined) {
    if (!manifestStatus.isFile() || manifestStatus.isSymbolicLink()) {
      throw new Error("system skill release manifest is not a regular file");
    }
    const bytes = await readFile(manifestPath);
    if (bytes.byteLength > 4 * 1024 * 1024)
      throw new Error("system skill release manifest is too large");
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("system skill release manifest is invalid");
    }
    const manifest = parsed as { version?: unknown; files?: unknown };
    if (typeof manifest.version !== "string" || !Array.isArray(manifest.files)) {
      throw new Error("system skill release manifest is invalid");
    }
    const required = SYSTEM_DOCS_FILES.map(
      (name) => `packages/kernel/assets/skills/.system/clarvis-docs/${name}`,
    );
    const files = manifest.files as { path?: unknown; sha256?: unknown }[];
    if (!required.every((name) => files.some((file) => file.path === name))) {
      return publishSystemDocs({ globalDir, revision: manifest.version });
    }
    for (const name of required) {
      const expected = files.find((file) => file.path === name)?.sha256;
      if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
        throw new Error(`system skill release entry is invalid: ${name}`);
      }
      const relative = name.slice("packages/kernel/assets/skills/.system/clarvis-docs/".length);
      const actual = createHash("sha256")
        .update(await readFile(join(sourceDir, relative)))
        .digest("hex");
      if (actual !== expected) throw new Error(`system skill release file changed: ${name}`);
    }
    return publishSystemDocs({ sourceDir, globalDir, revision: manifest.version });
  }
  return publishSystemDocs({ sourceDir, globalDir, revision: "source" });
}
