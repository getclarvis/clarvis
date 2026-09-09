#!/usr/bin/env bun
/**
 * Build the distributable `@clarvis/code` artifact.
 *
 * @remarks Running the TUI from source costs ~3.2s of every launch: `cli.ts`
 *   installs `@opentui/solid`'s Bun plugin, which pipes each of the package's
 *   `.tsx` files through Babel on the way in (measured: 466ms to load Babel plus
 *   2700ms to transform 44 files). Bun's transpiler cache does not cover plugin
 *   output, so that work is repeated on every start. Applying the same transform
 *   here, once, is what the artifact buys.
 *
 *   Two things this build must get right, both of which a passing unit-test
 *   suite would not catch, because the tests import `src/` directly:
 *
 *   - **Assets.** Modules that locate a shipped file relative to their own
 *     source path stop resolving once bundled. Those files are copied next to
 *     the artifact here and picked up by the second candidate each reader
 *     declares. `bun build` only emits assets it can see through an `import`;
 *     these are read with `readFileSync`, so it cannot.
 *   - **The renderer.** `@opentui/core` owns its native package, parser worker
 *     and grammar assets. The whole package stays external so those resources
 *     remain relative to its own entry point. The artifact is therefore
 *     package-local, not standalone.
 *
 *   - **Lazy runtime boundaries.** `@clarvis/llm` deliberately imports its AI
 *     SDK adapter only when a provider is first used. A monolithic Bun bundle
 *     flattened that boundary and made the idle TUI retain provider SDKs it
 *     had never called. Code splitting is therefore a memory invariant, not a
 *     deployment preference; this build verifies the adapter remains behind a
 *     generated dynamic chunk.
 *
 *   - **Source maps.** Bun eagerly discovers maps sitting beside runtime
 *     JavaScript, even when they are emitted as `external`, and retains tens of
 *     MiB of mapping data at idle. Developer builds retain them under
 *     `dist/maps/`, where the runtime does not auto-load them. `--install`
 *     omits them entirely from the linked installation.
 *
 *   `tooling/artifact/smoke.ts` proves these contracts against a clean HOME.
 */
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";
import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDetachedSourceMaps,
  assertInstallArtifact,
  assertLazyProviderArtifact,
  assertLazySurfaceArtifact,
  assertRelocatableArtifact,
} from "./contract.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = join(packageRoot, "..", "..");
const outdir = join(packageRoot, "dist");
const installBuild = Bun.argv.includes("--install");

/**
 * Files read at runtime by path rather than imported, which the bundler cannot
 * discover and which therefore have to be placed beside the artifact.
 *
 * @remarks Each `to` matches the bundled-artifact candidate its reader looks
 *   for - keep the two in step.
 */
const ASSETS: { from: string; to: string; reader: string }[] = [
  {
    from: join(repoRoot, "packages/kernel/src/data/models-dev.json"),
    to: join(outdir, "models-dev.json"),
    reader: "packages/kernel/src/models/model-catalog.ts",
  },
];

/** Assert that the provider adapter stayed behind the source graph's dynamic import. */
async function assertLazyProviderChunk(outputs: readonly Bun.BuildArtifact[]): Promise<void> {
  const entry = outputs.find((output) => output.kind === "entry-point");
  if (entry === undefined) throw new Error("build emitted no entry point");
  const javascriptChunks = outputs.filter(
    (output) => output.path !== entry.path && output.path.endsWith(".js"),
  );
  assertLazyProviderArtifact({
    entrySource: await Bun.file(entry.path).text(),
    javascriptChunks: await Promise.all(
      javascriptChunks.map(async (chunk) => ({
        path: chunk.path,
        source: await Bun.file(chunk.path).text(),
      })),
    ),
  });
  assertLazySurfaceArtifact({
    entrySource: await Bun.file(entry.path).text(),
    javascriptChunks: await Promise.all(
      javascriptChunks.map(async (chunk) => ({
        path: chunk.path,
        source: await Bun.file(chunk.path).text(),
      })),
    ),
  });
}

/** Reject generated JavaScript tied to this checkout's absolute path. */
async function assertRelocatableBuild(outputs: readonly Bun.BuildArtifact[]): Promise<void> {
  const javascript = outputs.filter((output) => output.path.endsWith(".js"));
  assertRelocatableArtifact({
    buildRoot: repoRoot,
    javascriptArtifacts: await Promise.all(
      javascript.map(async (artifact) => ({
        path: artifact.path,
        source: await Bun.file(artifact.path).text(),
      })),
    ),
  });
}

/** Move external maps away from runtime siblings so Bun does not load them eagerly. */
async function detachSourceMaps(outputs: readonly Bun.BuildArtifact[]): Promise<number> {
  const maps = outputs.filter((output) => output.path.endsWith(".map"));
  const mapsDir = join(outdir, "maps");
  await mkdir(mapsDir, { recursive: true });
  for (const map of maps) await rename(map.path, join(mapsDir, basename(map.path)));
  assertDetachedSourceMaps({
    adjacentMapPaths: (await readdir(outdir)).filter((name) => name.endsWith(".map")),
    detachedMapPaths: await readdir(mapsDir),
  });
  return maps.length;
}

async function copyAssets(): Promise<void> {
  for (const asset of ASSETS) {
    const info = await stat(asset.from).catch(() => null);
    if (!info) {
      throw new Error(
        `missing build asset: ${asset.from}\n  required by ${asset.reader}\n` +
          `  if it moved, update both that reader's candidate list and ASSETS here`,
      );
    }
    await mkdir(dirname(asset.to), { recursive: true });
    await cp(asset.from, asset.to, { recursive: info.isDirectory() });
  }
}

async function main(): Promise<void> {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  const started = performance.now();
  const result = await Bun.build({
    entrypoints: [join(packageRoot, "src/index.tsx"), join(packageRoot, "src/local-host.ts")],
    target: "bun",
    outdir,
    plugins: [createSolidTransformPlugin()],
    // Keep OpenTUI package-owned at runtime. Its parser worker and grammars are
    // resolved relative to its own entry point; bundling core rewrites that
    // import.meta.url and disconnects those assets from their owner.
    // Pino and thread-stream also resolve workers relative to their package
    // directories. Bundling them materializes the build host's absolute
    // node_modules path in generated __dirname values.
    external: ["@opentui/core", "@opentui/core-*", "pino"],
    splitting: true,
    minify: true,
    sourcemap: installBuild ? "none" : "external",
  });

  if (!result.success) {
    for (const log of result.logs) process.stderr.write(String(log) + "\n");
    throw new Error("bun build failed");
  }

  const outputs = result.outputs;

  await assertLazyProviderChunk(outputs);
  await assertRelocatableBuild(outputs);
  const sourceMaps = installBuild ? 0 : await detachSourceMaps(outputs);
  if (installBuild) {
    const javascript = outputs.filter((output) => output.path.endsWith(".js"));
    assertInstallArtifact({
      artifactPaths: outputs.map((output) => output.path),
      javascriptArtifacts: await Promise.all(
        javascript.map(async (artifact) => ({
          path: artifact.path,
          source: await Bun.file(artifact.path).text(),
        })),
      ),
    });
  }
  await copyAssets();

  const entry = result.outputs.find((o) => o.kind === "entry-point");
  const chunks = outputs.filter((o) => o.kind === "chunk" && o.path.endsWith(".js"));
  const bytes = entry ? (await stat(entry.path)).size : 0;
  process.stdout.write(
    `built ${outdir}/index.js  ${(bytes / 1024 / 1024).toFixed(2)} MB  ` +
      `${chunks.length} lazy chunks  ` +
      `${installBuild ? "no source maps" : `${sourceMaps} detached maps`}  ` +
      `${outputs.length} outputs  ` +
      `${(performance.now() - started).toFixed(0)}ms\n`,
  );
}

await main();
