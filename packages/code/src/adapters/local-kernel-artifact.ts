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

/** Resolve the companion shipped beside the running bundle, or the explicit source entry. */
export function resolveLocalKernelArtifact(): Promise<LocalKernelArtifact> {
  artifact ??= (async () => {
    const source = import.meta.url.endsWith(".ts");
    const entry = await realpath(
      fileURLToPath(new URL(source ? "../local-host.ts" : "./local-host.js", import.meta.url)),
    );
    const digest = createHash("sha256").update(process.version).update(Bun.version);
    if (source) {
      const repository = join(dirname(entry), "..", "..", "..");
      digest.update(await readFile(join(repository, "bun.lock")));
      for (const name of (await readdir(join(repository, "packages"))).sort()) {
        const root = join(repository, "packages", name);
        digest
          .update(name)
          .update("\0")
          .update(await readFile(join(root, "package.json")));
        await hashTree(join(root, "src"), digest);
      }
    } else await hashTree(dirname(entry), digest);
    return {
      command: [await realpath(process.execPath), entry] as const,
      artifactId: `clarvis:${productVersion()}:${digest.digest("hex")}`,
    };
  })();
  return artifact;
}
