#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareReleaseSources } from "../lib/release-prepare.ts";

const RELEASE_FILES = {
  packageJson: "package.json",
  installSh: "install.sh",
  installPowerShell: "install.ps1",
  changelog: "CHANGELOG.md",
} as const;

function localDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Prepares one release from the changelog's Unreleased section without publishing it. */
export function prepareRelease(root: string, version: string, date = localDate()): void {
  const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
  const prepared = prepareReleaseSources(
    {
      packageJson: read(RELEASE_FILES.packageJson),
      installSh: read(RELEASE_FILES.installSh),
      installPowerShell: read(RELEASE_FILES.installPowerShell),
      changelog: read(RELEASE_FILES.changelog),
    },
    version,
    date,
  );
  for (const key of Object.keys(RELEASE_FILES) as (keyof typeof RELEASE_FILES)[]) {
    writeFileSync(resolve(root, RELEASE_FILES[key]), prepared[key], "utf8");
  }
  process.stdout.write(
    `prepared Clarvis ${prepared.version} from ${prepared.previousVersion} for ${date}; no commit, tag, or publication was performed\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, ...rest] = process.argv.slice(2);
  if (!version || rest.length > 0) {
    process.stderr.write("usage: bun run release:prepare <version>\n");
    process.exitCode = 1;
  } else {
    prepareRelease(resolve(import.meta.dir, "../.."), version);
  }
}
