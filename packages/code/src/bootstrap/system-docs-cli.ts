import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { publishSystemDocs } from "@clarvis/kernel/system-docs";

import {
  CLARVIS_DOCS_RELEASE_FILES,
  parseReleaseManifest,
  releaseRequiresClarvisDocs,
  verifyReleaseTree,
} from "../update/release-manifest.ts";
import type { ReleaseTarget } from "../update-contract.ts";

interface Request {
  root: string;
  version: string;
  target?: ReleaseTarget;
  globalDir?: string;
  kind: "release" | "source";
}

/** Parse the standalone publisher's bounded installer arguments. */
export function parseSystemDocsArgs(argv: readonly string[]): Request {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !["--release-root", "--source-root", "--version", "--target", "--global-dir"].includes(key) ||
      values.has(key)
    ) {
      throw new Error("invalid system documentation publication arguments");
    }
    values.set(key, value);
  }
  const releaseRoot = values.get("--release-root");
  const sourceRoot = values.get("--source-root");
  const version = values.get("--version");
  if ((releaseRoot === undefined) === (sourceRoot === undefined) || version === undefined) {
    throw new Error("publication needs one source and its product version");
  }
  const target = values.get("--target") as ReleaseTarget | undefined;
  if (releaseRoot !== undefined && target === undefined) {
    throw new Error("release publication needs its target");
  }
  return {
    root: resolve((releaseRoot ?? sourceRoot) as string),
    version,
    kind: releaseRoot === undefined ? "source" : "release",
    ...(target === undefined ? {} : { target }),
    ...(values.get("--global-dir") === undefined
      ? {}
      : { globalDir: resolve(values.get("--global-dir") as string) }),
  };
}

/** Verify a selected release or source checkout, then publish its exact documentation revision. */
export async function publishSelectedSystemDocs(input: Request): Promise<string> {
  const sourceDir = join(
    input.root,
    "packages",
    "kernel",
    "assets",
    "skills",
    ".system",
    "clarvis-docs",
  );
  if (input.kind === "release") {
    const text = await readFile(join(input.root, "release.json"), "utf8");
    if (text.length > 4 * 1024 * 1024) throw new Error("release manifest is too large");
    const manifest = parseReleaseManifest(JSON.parse(text), {
      version: input.version,
      target: input.target as ReleaseTarget,
    });
    await verifyReleaseTree(input.root, manifest);
    if (
      !CLARVIS_DOCS_RELEASE_FILES.every((path) => manifest.files.some((file) => file.path === path))
    ) {
      return publishSystemDocs({ globalDir: input.globalDir, revision: input.version });
    }
  } else if (!releaseRequiresClarvisDocs(input.version)) {
    return publishSystemDocs({ globalDir: input.globalDir, revision: input.version });
  }
  return publishSystemDocs({ sourceDir, globalDir: input.globalDir, revision: input.version });
}

if (import.meta.main) {
  try {
    process.stdout.write(
      `${await publishSelectedSystemDocs(parseSystemDocsArgs(process.argv.slice(2)))}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `clarvis system documentation: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
