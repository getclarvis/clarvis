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
import { selectDiagnosticEvent, type DiagnosticSelection } from "./diagnostic-reader.ts";
import {
  OPERATIONAL_EVENTS,
  type OperationalEventName,
} from "#src/core/operational-event-contract.ts";
import { RELEASE_REPOSITORY, releaseTarget } from "#src/update-contract.ts";
import {
  CLARVIS_DOCS_PUBLISHER_FILE,
  CLARVIS_DOCS_RELEASE_FILES,
  releaseRequiresClarvisDocs,
} from "#src/update/release-manifest.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const artifact = join(packageRoot, "dist/index.js");

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
 * Read one validated event out of the run's diagnostic logs, newest file first.
 *
 * @param home - the throwaway HOME the run wrote its Clarvis state into.
 * @returns found, absent, or pending evidence; invalid completed records throw.
 */
async function readDiagnosticEvent<Name extends OperationalEventName>(
  home: string,
  event: Name,
): Promise<Exclude<DiagnosticSelection<Name>, { kind: "invalid" }>> {
  for (const log of diagnosticLogsUnder(home).reverse()) {
    const selection = selectDiagnosticEvent(await readFile(log, "utf8"), log, event);
    if (selection.kind === "invalid")
      throw new Error(
        `invalid diagnostic evidence: file=${selection.file} event=${selection.event} field=${selection.field}`,
      );
    if (selection.kind !== "absent") return selection;
  }
  return { kind: "absent" };
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
  let painted: DiagnosticSelection<typeof OPERATIONAL_EVENTS.appPainted>;
  let shellPainted: DiagnosticSelection<typeof OPERATIONAL_EVENTS.shellPainted>;
  let markdown: DiagnosticSelection<typeof OPERATIONAL_EVENTS.markdownPreloadCompleted>;
  let catalogLoad: DiagnosticSelection<typeof OPERATIONAL_EVENTS.catalogLoadStarted>;
  let updateCheck: DiagnosticSelection<typeof OPERATIONAL_EVENTS.updateCheckSkipped>;
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
        const bootPainted = await readDiagnosticEvent(
          fixture.global,
          OPERATIONAL_EVENTS.appPainted,
        );
        const preload = await readDiagnosticEvent(
          fixture.global,
          OPERATIONAL_EVENTS.markdownPreloadCompleted,
        );
        const catalog = await readDiagnosticEvent(
          fixture.global,
          OPERATIONAL_EVENTS.catalogLoadStarted,
        );
        if (catalog.kind === "found") throw new Error("smoke FAILED: first paint loaded catalog");
        const skipped = await readDiagnosticEvent(
          fixture.global,
          OPERATIONAL_EVENTS.updateCheckSkipped,
        );
        return (
          bootPainted.kind === "found" &&
          preload.kind === "found" &&
          catalog.kind === "absent" &&
          skipped.kind === "found"
        );
      },
      timeoutMs: TIMEOUT_MS,
      pollMs: 100,
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

    painted = await readDiagnosticEvent(fixture.global, OPERATIONAL_EVENTS.appPainted);
    shellPainted = await readDiagnosticEvent(fixture.global, OPERATIONAL_EVENTS.shellPainted);
    markdown = await readDiagnosticEvent(
      fixture.global,
      OPERATIONAL_EVENTS.markdownPreloadCompleted,
    );
    catalogLoad = await readDiagnosticEvent(fixture.global, OPERATIONAL_EVENTS.catalogLoadStarted);
    updateCheck = await readDiagnosticEvent(fixture.global, OPERATIONAL_EVENTS.updateCheckSkipped);
  } finally {
    await fixture.cleanup();
  }
  if (painted.kind !== "found") {
    process.stderr.write(
      `smoke FAILED: the artifact painted but wrote no app.boot.painted record\n` +
        `--debug is the only diagnostic channel a bundled clarvis has\n`,
    );
    process.exit(1);
  }
  if (shellPainted.kind !== "found") {
    process.stderr.write(
      `smoke FAILED: the artifact painted but wrote no app.boot.shell-painted record\n`,
    );
    process.exit(1);
  }
  if (
    markdown.kind !== "found" ||
    markdown.details.markdown !== true ||
    markdown.details.markdownInline !== true
  ) {
    process.stderr.write(
      `smoke FAILED: OpenTUI Markdown parsers did not preload from their package assets\n`,
    );
    process.exit(1);
  }
  if (painted.details.deferred_catalog !== true || catalogLoad.kind !== "absent") {
    process.stderr.write(
      `smoke FAILED: first paint loaded the models.dev catalog ` +
        `(deferred_catalog=${String(painted.details.deferred_catalog)}, catalog_load=${String(catalogLoad.kind)})\n`,
    );
    process.exit(1);
  }
  if (updateCheck.kind !== "found" || updateCheck.details.reason !== "unmanaged") {
    process.stderr.write(
      `smoke FAILED: unmanaged artifact did not skip the automatic release request ` +
        `(reason=${updateCheck.kind === "found" ? updateCheck.details.reason : updateCheck.kind})\n`,
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
        files: [
          { path: "placeholder", size: 0, sha256: "a".repeat(64) },
          ...(releaseRequiresClarvisDocs(product.version)
            ? [...CLARVIS_DOCS_RELEASE_FILES, CLARVIS_DOCS_PUBLISHER_FILE].map((path) => ({
                path,
                size: 1,
                sha256: "a".repeat(64),
              }))
            : []),
        ],
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
        const available = await readDiagnosticEvent(
          managed.global,
          OPERATIONAL_EVENTS.updateAvailable,
        );
        return (
          available.kind === "found" && available.details.available_version === availableVersion
        );
      },
      timeoutMs: TIMEOUT_MS,
      pollMs: 100,
      overrides: { CLARVIS_INSTALL_ROOT: installRoot },
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
      `(startup shell paint: ${String(shellPainted.details.elapsed_ms)}ms, ` +
      `complete app paint: ${String(painted.details.elapsed_ms)}ms, ` +
      `deferred_catalog=${String(painted.details.deferred_catalog)}, ` +
      `managed update state: ${updateNoticeMs.toFixed(0)}ms)\n`,
  );
}

await main();
