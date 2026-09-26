#!/usr/bin/env bun
/**
 * The `clarvis` entry: answer application-free flags or update, then hand over
 * to the TypeScript source.
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
import { fileURLToPath } from "node:url";
import { helpText, parseMode, productVersion, versionText } from "./cli-args.ts";
import { privateEntry, productRootForEntry } from "./cli-entry.ts";

const argv = process.argv.slice(2);
const privateMode = privateEntry(argv);
if (privateMode === "remote-kernel") {
  process.env.CLARVIS_PRODUCT_ROOT = productRootForEntry(fileURLToPath(import.meta.url));
  await import("./remote-host.ts");
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

process.env.CLARVIS_PRODUCT_ROOT = productRootForEntry(fileURLToPath(import.meta.url));

await import("@opentui/solid/preload");
await import("./index.tsx");
