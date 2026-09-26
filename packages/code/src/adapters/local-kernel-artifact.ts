import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { productVersion } from "../cli-args.ts";

/** A concrete application host entry and its content identity; never selected by a model request. */
export interface LocalKernelArtifact {
  command: readonly [string, ...string[]];
  artifactId: string;
}

async function hashTree(root: string, digest: ReturnType<typeof createHash>): Promise<void> {
  const paths: string[] = [];
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error("host artifact contains an unexpected symbolic link");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile() && !entry.name.endsWith(".map")) paths.push(path);
      if (paths.length > 20_000) throw new Error("host artifact exceeds its file budget");
    }
  }
  await collect(root);
  let bytes = 0;
  for (const path of paths.sort()) {
    const metadata = await stat(path);
    bytes += metadata.size;
    if (bytes > 256 * 1024 * 1024) throw new Error("host artifact exceeds its byte budget");
    digest
      .update(relative(root, path))
      .update("\0")
      .update(await readFile(path))
      .update("\0");
  }
}

let artifact: Promise<LocalKernelArtifact> | undefined;

/** Resolve the owning package from either source modules or a development bundle. */
async function codePackageRoot(): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    const manifest = await readFile(join(directory, "package.json"), "utf8").catch(() => undefined);
    if (manifest !== undefined) {
      const value: unknown = JSON.parse(manifest);
      if (
        typeof value === "object" &&
        value !== null &&
        "name" in value &&
        value.name === "@clarvis/code"
      ) {
        return directory;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("Code source package root is unavailable");
}

/** Resolve the source companion shipped with the application. */
export function resolveLocalKernelArtifact(): Promise<LocalKernelArtifact> {
  artifact ??= (async () => {
    const entry = await realpath(join(await codePackageRoot(), "src", "local-host.ts"));
    const digest = createHash("sha256").update(process.version).update(Bun.version);
    const repository = join(dirname(entry), "..", "..", "..");
    digest.update(await readFile(join(repository, "bun.lock")));
    for (const name of (await readdir(join(repository, "packages"))).sort()) {
      const root = join(repository, "packages", name);
      let manifest: Buffer;
      try {
        manifest = await readFile(join(root, "package.json"));
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") continue;
        throw error;
      }
      digest.update(name).update("\0").update(manifest);
      await hashTree(join(root, "src"), digest);
    }
    return {
      command: [await realpath(process.execPath), entry] as const,
      artifactId: `clarvis:${productVersion()}:${digest.digest("hex")}`,
    };
  })();
  return artifact;
}
