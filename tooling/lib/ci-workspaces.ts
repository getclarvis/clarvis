import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface CiWorkspace {
  name: string;
  directory: string;
  relative: string;
  scripts: Record<string, string>;
}

/** Require a real directory at every segment; CI never follows workspace or output symlinks. */
export async function requireCiDirectory(root: string, relative: string): Promise<string> {
  let directory = await realpath(root);
  for (const segment of relative.split("/")) {
    if (!segment || segment === "." || segment === ".." || segment.includes("\\")) {
      throw new Error(`Invalid CI directory: ${relative}`);
    }
    directory = join(directory, segment);
    if (!(await lstat(directory)).isDirectory()) {
      throw new Error(`CI directory must be a real directory: ${relative}`);
    }
  }
  return directory;
}

/** Read the explicit workspace inventory in manifest order, rejecting aliases and missing scripts. */
export async function readCiWorkspaces(
  root: string,
  requiredScript?: string,
): Promise<CiWorkspace[]> {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  if (!Array.isArray(manifest.workspaces) || manifest.workspaces.length === 0) {
    throw new Error("package.json must declare a nonempty explicit workspace inventory");
  }
  const seen = new Set<string>();
  const workspaces: CiWorkspace[] = [];
  for (const relative of manifest.workspaces) {
    if (typeof relative !== "string" || !/^packages\/[a-z][a-z0-9-]*$/.test(relative)) {
      throw new Error(`Invalid confined workspace directory: ${String(relative)}`);
    }
    if (seen.has(relative)) throw new Error(`Duplicate workspace: ${relative}`);
    seen.add(relative);
    const directory = await requireCiDirectory(root, relative);
    const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    const name = `@clarvis/${relative.slice("packages/".length)}`;
    if (pkg.name !== name) throw new Error(`${relative}: expected workspace name ${name}`);
    const scripts: Record<string, string> = pkg.scripts ?? {};
    if (
      requiredScript &&
      (typeof scripts[requiredScript] !== "string" || !scripts[requiredScript].trim())
    ) {
      throw new Error(`${name}: missing ${requiredScript} script`);
    }
    workspaces.push({ name, relative, directory, scripts });
  }
  return workspaces;
}
