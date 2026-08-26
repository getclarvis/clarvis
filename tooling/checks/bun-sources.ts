#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PYTHON_SOURCE = /\.(?:py|pyi|pyw)$/i;

/** Return tracked paths that would make the Bun application depend on Python source. */
export function pythonSourcePaths(paths) {
  return paths.filter((path) => PYTHON_SOURCE.test(path)).sort();
}

/** Read tracked and unignored paths without scanning dependencies or ignored build output. */
export function repositoryPaths(root) {
  const result = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) {
    const diagnostic = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`git ls-files failed${diagnostic === "" ? "" : `: ${diagnostic}`}`);
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\0")
    .filter((path) => path !== "" && existsSync(resolve(root, path)));
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const failures = pythonSourcePaths(repositoryPaths(root));
  if (failures.length > 0) {
    console.error(
      `Python source files are not allowed; use Bun/TypeScript:\n${failures.join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    console.log("bun sources: no tracked Python source files");
  }
}
