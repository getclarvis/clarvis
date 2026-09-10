#!/usr/bin/env bun
/**
 * The `clarvis` entry: answer application-free flags or update, then hand over
 * to the built bundle.
 *
 * @remarks
 * **Everything statically imported here is paid on every launch**, including
 * `--version`. That is why the only imports are `cli-args.ts` (whose runtime
 * graph is itself plus the root product manifest) and `cli-entry.ts` (which imports
 * nothing): `--help` and `--version` used to be handled inside `main()`, after
 * the whole 847-file graph had loaded, and cost ~2.5 s to print one string.
 * `tests/architecture/cli-fast-path.test.ts` fails if that regresses.
 *
 * A usage error is deliberately *not* intercepted. It is a human at a keyboard
 * rather than a scripted call, so it can afford the slow path, and delegating
 * keeps validation semantics owned in one place.
 *
 * This file is invisible to coverage (see `coverage.ts`), so it holds no
 * decisions of its own — `resolveEntry` makes them and is tested directly.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { helpText, parseMode, productVersion, versionText } from "./cli-args.ts";
import { privateEntry, resolveEntry } from "./cli-entry.ts";

const argv = process.argv.slice(2);
const privateMode = privateEntry(argv);
if (privateMode === "remote-kernel") {
  const remoteDistPath = fileURLToPath(new URL("../dist/remote-host.js", import.meta.url));
  const remoteChoice = resolveEntry({
    distPath: remoteDistPath,
    distExists: existsSync(remoteDistPath),
    forceSource: process.env.CLARVIS_CODE_SOURCE === "1",
  });
  if (remoteChoice.kind === "error") {
    process.stderr.write(remoteChoice.message + "\n");
    process.exit(1);
  }
  if (remoteChoice.kind === "dist") await import(pathToFileURL(remoteDistPath).href);
  else await import("./remote-host.ts");
  process.exit(process.exitCode ?? 0);
}

const mode = parseMode(argv);
if (mode.kind === "help") {
  process.stdout.write(helpText() + "\n");
  process.exit(0);
}
if (mode.kind === "version") {
  process.stdout.write(versionText() + "\n");
  process.exit(0);
}
if (mode.kind === "update") {
  const { runUpdateCommand } = await import("./update/index.ts");
  process.exit(await runUpdateCommand({ currentVersion: productVersion() }));
}

const distPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const choice = resolveEntry({
  distPath,
  distExists: existsSync(distPath),
  forceSource: process.env.CLARVIS_CODE_SOURCE === "1",
});

if (choice.kind === "error") {
  process.stderr.write(choice.message + "\n");
  process.exit(1);
}
if (choice.kind === "dist") {
  await import(pathToFileURL(distPath).href);
} else {
  await import("@opentui/solid/preload");
  await import("./index.tsx");
}
