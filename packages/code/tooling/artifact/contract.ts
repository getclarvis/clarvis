/** The adapter class marker emitted in the provider SDK chunk. */
const PROVIDER_ADAPTER_MARKER = "class AiSdkAdapter";

const LAZY_SURFACE_MARKERS = [
  "no diff in the transcript yet",
  "no plans yet",
  "Unverified entitlement",
  "no sessions yet",
  "no workflows yet",
  "Clarvis-owned local files",
  "Clarvis Doctor",
  "Select safety preset",
] as const;

/** Assert the memory-sensitive layout of the distributable JavaScript artifact. */
export function assertLazyProviderArtifact(input: {
  entrySource: string;
  javascriptChunks: readonly { path: string; source: string }[];
}): void {
  if (input.javascriptChunks.length === 0) {
    throw new Error("artifact has no lazy JavaScript chunks; build flattened dynamic imports");
  }
  if (input.entrySource.includes(PROVIDER_ADAPTER_MARKER)) {
    throw new Error("artifact loads AiSdkAdapter eagerly instead of from a lazy chunk");
  }
  const providerChunk = input.javascriptChunks.find((chunk) =>
    chunk.source.includes(PROVIDER_ADAPTER_MARKER),
  );
  if (providerChunk === undefined) {
    throw new Error("artifact has no lazy chunk containing AiSdkAdapter");
  }
  const chunkBasename = providerChunk.path.split(/[\\/]/).at(-1);
  if (chunkBasename === undefined) throw new Error("artifact provider chunk has no basename");
  const dynamicImport = `await import("./${chunkBasename}")`;
  const staticImport = `from "./${chunkBasename}"`;
  const sources = [input.entrySource, ...input.javascriptChunks.map((chunk) => chunk.source)];
  if (!sources.some((source) => source.includes(dynamicImport))) {
    throw new Error("artifact has no dynamic import for the AiSdkAdapter chunk");
  }
  if (sources.some((source) => source.includes(staticImport))) {
    throw new Error("artifact statically imports the AiSdkAdapter chunk");
  }
}

/** Assert cold full-page and floating surfaces remain outside the first-load entrypoint. */
export function assertLazySurfaceArtifact(input: {
  entrySource: string;
  javascriptChunks: readonly { path: string; source: string }[];
}): void {
  for (const marker of LAZY_SURFACE_MARKERS) {
    if (input.entrySource.includes(marker)) {
      throw new Error(`artifact loads the surface containing ${JSON.stringify(marker)} eagerly`);
    }
    if (!input.javascriptChunks.some((chunk) => chunk.source.includes(marker))) {
      throw new Error(`artifact has no lazy surface chunk containing ${JSON.stringify(marker)}`);
    }
  }
}

/** Assert source maps remain available offline without being auto-loaded by Bun at startup. */
export function assertDetachedSourceMaps(input: {
  adjacentMapPaths: readonly string[];
  detachedMapPaths: readonly string[];
}): void {
  if (input.adjacentMapPaths.length > 0) {
    throw new Error("source maps must not sit beside runtime JavaScript; Bun loads them eagerly");
  }
  if (!input.detachedMapPaths.some((path) => path.endsWith("index.js.map"))) {
    throw new Error("artifact must retain its entrypoint source map under dist/maps");
  }
}

/** Assert the installed artifact contains no source-map payload. */
export function assertInstallArtifact(input: { artifactPaths: readonly string[] }): void {
  const sourceMap = input.artifactPaths.find((path) => path.endsWith(".map"));
  if (sourceMap !== undefined) {
    throw new Error(`installed artifact must not contain source maps: ${sourceMap}`);
  }
}

/** Assert generated JavaScript is independent of the build host's checkout location. */
export function assertRelocatableArtifact(input: {
  buildRoot: string;
  javascriptArtifacts: readonly { path: string; source: string }[];
}): void {
  const escapedRoot = input.buildRoot.replaceAll("\\", "\\\\");
  const slashRoot = input.buildRoot.replaceAll("\\", "/");
  const forbidden = new Set([input.buildRoot, escapedRoot, slashRoot]);
  for (const artifact of input.javascriptArtifacts) {
    if ([...forbidden].some((root) => root.length > 0 && artifact.source.includes(root))) {
      throw new Error(`artifact embeds the build-host path: ${artifact.path}`);
    }
  }
}
