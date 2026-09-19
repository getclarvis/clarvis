#!/usr/bin/env bun
/**
 * Boot the built artifact and assert it reaches first paint.
 *
 * @remarks The unit suite imports `src/` directly - deeply, by path - so it
 *   cannot run against a bundle and never observes one. Everything that only
 *   breaks *after* bundling is invisible to it: 1017 tests passed green while a
 *   bundled `code` died on startup for want of `models-dev.json`.
 *
 *   **The fresh SmokeContext is the point.** It proves first paint does not read or
 *   project either a user cache or the shipped models.dev snapshot. The asset
 *   is still checked before boot because Providers must be able to load it
 *   later on a fresh install.
 *
 *   POSIX-only: OpenTUI needs a PTY. Prefer `script(1)` (both util-linux and BSD
 *   syntax are supported), and fall back to the repository's documented tmux
 *   driver when a minimal host does not install `script`.
 *
 *   It boots with `--debug` and asserts `app.boot.painted` reaches the JSONL.
 *   The screen marker alone proves a frame was drawn; the record proves the
 *   diagnostic channel — the only thing that says anything at all about a
 *   bundled binary in the field — survived bundling too, and it carries the
 *   boot's elapsed time, which the screen does not.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSmokeFixture } from "./isolation.ts";
import { bootAndObserve, readable } from "./pty.ts";
import {
  assertDetachedSourceMaps,
  assertLazyProviderArtifact,
  assertLazySurfaceArtifact,
} from "./contract.ts";
import { APP_READY_MARKER } from "./markers.ts";
import { RELEASE_REPOSITORY, releaseTarget } from "../../src/update-contract.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const artifact = join(packageRoot, "dist/index.js");
const repositoryRoot = join(packageRoot, "..", "..");
const confinement =
  process.env.CLARVIS_SMOKE_REQUIRE_CONFINEMENT === "1" ? "required" : "environment";

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000);

/**
 * Assets the artifact reads by path at runtime, with the module that reads each.
 *
 * @remarks Checked before booting so a missing one is reported as itself rather
 *   than as an opaque startup failure.
 */
const REQUIRED_ASSETS: { path: string; reader: string }[] = [
  { path: join(packageRoot, "dist/models-dev.json"), reader: "kernel model-catalog.ts" },
];

/** The `details` of the `app.boot.painted` record the smoke run asserts on. */
interface BootPaintedDetails {
  elapsed_ms?: unknown;
  deferred_catalog?: unknown;
}

interface BootShellPaintedDetails {
  elapsed_ms?: unknown;
}

interface MarkdownPreloadDetails {
  markdown?: unknown;
  markdownInline?: unknown;
}

interface UpdateCheckSkippedDetails {
  reason?: unknown;
}

interface UpdateAvailableDetails {
  available_version?: unknown;
}

/** Every `code-debug-*.jsonl` written anywhere beneath `root`. */
function diagnosticLogsUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.startsWith("code-debug-") && entry.name.endsWith(".jsonl"))
        found.push(path);
    }
  };
  walk(root);
  return found.sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs);
}

/**
 * Read one event's details out of the run's diagnostic log.
 *
 * @param home - the throwaway HOME the run wrote its Clarvis state into.
 * @returns the record's details, or `null` when no log or no such record exists.
 */
async function readDiagnosticDetails<T>(home: string, event: string): Promise<T | null> {
  for (const log of diagnosticLogsUnder(home).reverse()) {
    const lines = (await readFile(log, "utf8")).split("\n").filter(Boolean);
    for (const line of lines) {
      let record: { event?: unknown; details?: unknown };
      try {
        record = JSON.parse(line) as typeof record;
      } catch {
        continue;
      }
      if (record.event === event) return (record.details ?? {}) as T;
    }
  }
  return null;
}

async function main(): Promise<void> {
  if (!existsSync(artifact)) {
    throw new Error(`no artifact at ${artifact}\n  run: bun --filter @clarvis/code build`);
  }
  const dist = join(packageRoot, "dist");
  const distNames = await readdir(dist);
  const chunkNames = distNames.filter((name) => /^chunk-[a-z0-9]+\.js$/.test(name));
  assertLazyProviderArtifact({
    entrySource: await readFile(artifact, "utf8"),
    javascriptChunks: await Promise.all(
      chunkNames.map(async (name) => ({
        path: name,
        source: await readFile(join(dist, name), "utf8"),
      })),
    ),
  });
  assertLazySurfaceArtifact({
    entrySource: await readFile(artifact, "utf8"),
    javascriptChunks: await Promise.all(
      chunkNames.map(async (name) => ({
        path: name,
        source: await readFile(join(dist, name), "utf8"),
      })),
    ),
  });
  assertDetachedSourceMaps({
    adjacentMapPaths: distNames.filter((name) => name.endsWith(".map")),
    detachedMapPaths: await readdir(join(dist, "maps")),
  });
  for (const asset of REQUIRED_ASSETS) {
    if (!existsSync(asset.path)) {
      throw new Error(`artifact is missing ${asset.path}\n  read at runtime by ${asset.reader}`);
    }
  }
  const fixture = await createSmokeFixture("clarvis-artifact-smoke-");
  let result: Awaited<ReturnType<typeof bootAndObserve>>;
  let painted: BootPaintedDetails | null;
  let shellPainted: BootShellPaintedDetails | null;
  let markdown: MarkdownPreloadDetails | null;
  let catalogLoad: Record<string, unknown> | null;
  let updateCheck: UpdateCheckSkippedDetails | null;
  try {
    if (existsSync(fixture.paths.modelsCacheFile)) {
      throw new Error("fixture is not a fresh install: it has a models cache");
    }

    result = await bootAndObserve({
      entry: artifact,
      args: ["--debug"],
      context: fixture,
      markers: [{ name: "ready", text: APP_READY_MARKER }],
      afterMarkersReady: async () => {
        const bootPainted = await readDiagnosticDetails<BootPaintedDetails>(
          fixture.global,
          "app.boot.painted",
        );
        const preload = await readDiagnosticDetails<MarkdownPreloadDetails>(
          fixture.global,
          "markdown.preload.completed",
        );
        return bootPainted !== null && preload !== null;
      },
      timeoutMs: TIMEOUT_MS,
      pollMs: 100,
      confinement,
      readOnlyRoots: [repositoryRoot],
    });

    if (result.outcome !== "ready") {
      process.stderr.write(
        `smoke FAILED (${result.outcome}) after ${result.elapsed.toFixed(0)}ms\n` +
          `the built artifact did not reach first paint in its isolated fixture\n` +
          `--- screen ---\n${readable(result.screen).slice(-4000)}\n` +
          `--- stderr ---\n${result.stderr.slice(-2000)}\n`,
      );
      throw new Error(`artifact_smoke_${result.outcome}`);
    }

    painted = await readDiagnosticDetails<BootPaintedDetails>(fixture.global, "app.boot.painted");
    shellPainted = await readDiagnosticDetails<BootShellPaintedDetails>(
      fixture.global,
      "app.boot.shell-painted",
    );
    markdown = await readDiagnosticDetails<MarkdownPreloadDetails>(
      fixture.global,
      "markdown.preload.completed",
    );
    catalogLoad = await readDiagnosticDetails<Record<string, unknown>>(
      fixture.global,
      "catalog.load.started",
    );
    updateCheck = await readDiagnosticDetails<UpdateCheckSkippedDetails>(
      fixture.global,
      "update.check.skipped",
    );
  } finally {
    await fixture.cleanup();
  }
  if (painted === null) {
    process.stderr.write(
      `smoke FAILED: the artifact painted but wrote no app.boot.painted record\n` +
        `--debug is the only diagnostic channel a bundled clarvis has\n`,
    );
    process.exit(1);
  }
  if (shellPainted === null) {
    process.stderr.write(
      `smoke FAILED: the artifact painted but wrote no app.boot.shell-painted record\n`,
    );
    process.exit(1);
  }
  if (markdown?.markdown !== true || markdown.markdownInline !== true) {
    process.stderr.write(
      `smoke FAILED: OpenTUI Markdown parsers did not preload from their package assets\n`,
    );
    process.exit(1);
  }
  if (painted.deferred_catalog !== true || catalogLoad !== null) {
    process.stderr.write(
      `smoke FAILED: first paint loaded the models.dev catalog ` +
        `(deferred_catalog=${String(painted.deferred_catalog)}, catalog_load=${String(catalogLoad !== null)})\n`,
    );
    process.exit(1);
  }
  if (updateCheck?.reason !== "unmanaged") {
    process.stderr.write(
      `smoke FAILED: unmanaged artifact did not skip the automatic release request ` +
        `(reason=${String(updateCheck?.reason)})\n`,
    );
    process.exit(1);
  }

  const target = releaseTarget();
  if (target === undefined) throw new Error("native platform is not a release target");
  const product = JSON.parse(
    await readFile(join(packageRoot, "..", "..", "package.json"), "utf8"),
  ) as { version: string };
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(product.version);
  if (match === null) throw new Error("root product version is not canonical SemVer");
  const availableVersion =
    match[4] === undefined
      ? `${match[1]}.${match[2]}.${String(Number(match[3]) + 1)}`
      : `${match[1]}.${match[2]}.${match[3]}`;
  const managed = await createSmokeFixture("clarvis-update-smoke-");
  const installRoot = managed.install;
  const versionRoot = join(installRoot, "versions", `v${product.version}`);
  const managedPaths = managed.paths;
  let updateNoticeMs: number;
  try {
    await mkdir(versionRoot, { recursive: true });
    await mkdir(managedPaths.cache, { recursive: true });
    await writeFile(join(installRoot, "current"), `v${product.version}\n`);
    await writeFile(
      join(versionRoot, "release.json"),
      JSON.stringify({
        schema: 1,
        repository: RELEASE_REPOSITORY,
        version: product.version,
        target,
        files: [{ path: "placeholder", size: 0, sha256: "a".repeat(64) }],
      }),
    );
    await writeFile(
      managedPaths.updateCheckCacheFile,
      JSON.stringify({
        schema: 1,
        repository: RELEASE_REPOSITORY,
        checked_at: Date.now(),
        current_version: product.version,
        target,
        available: { version: availableVersion, tag_name: `v${availableVersion}` },
      }),
    );
    const update = await bootAndObserve({
      entry: artifact,
      args: ["--debug"],
      context: managed,
      markers: [
        { name: "ready", text: APP_READY_MARKER },
        { name: "update-header", text: `↑ v${product.version}` },
      ],
      afterMarkersReady: async () => {
        const available = await readDiagnosticDetails<UpdateAvailableDetails>(
          managed.global,
          "update.available",
        );
        return available?.available_version === availableVersion;
      },
      timeoutMs: TIMEOUT_MS,
      pollMs: 100,
      overrides: { CLARVIS_INSTALL_ROOT: installRoot },
      confinement,
      readOnlyRoots: [repositoryRoot],
    });
    const updateFrame = readable(update.screen);
    if (
      update.outcome !== "ready" ||
      update.marks.ready === undefined ||
      update.marks["update-header"] === undefined ||
      update.marks["update-header"] < update.marks.ready ||
      !updateFrame.includes(`↑ v${product.version}`)
    ) {
      throw new Error(
        `managed update notice smoke ${update.outcome}\n` +
          `marks=${JSON.stringify(update.marks)}\n${updateFrame.slice(-4000)}\n${update.stderr.slice(-1000)}`,
      );
    }
    updateNoticeMs = update.elapsed;
  } finally {
    await managed.cleanup();
  }

  process.stdout.write(
    `smoke ok - artifact and required diagnostics settled in ${result.elapsed.toFixed(0)}ms ` +
      `(startup shell paint: ${String(shellPainted.elapsed_ms)}ms, ` +
      `complete app paint: ${String(painted.elapsed_ms)}ms, ` +
      `deferred_catalog=${String(painted.deferred_catalog)}, ` +
      `managed update state: ${updateNoticeMs.toFixed(0)}ms)\n`,
  );
}

await main();
