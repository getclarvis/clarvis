import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");
const output = join(root, "assets", "native");
mkdirSync(output, { recursive: true });

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const assets: Record<string, { path: string; sha256: string }> = {};
if (process.platform === "linux") {
  const launcher = join(output, "linux-launcher");
  const built = spawnSync(
    "cc",
    [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      join(root, "native", "linux-launcher.c"),
      "-o",
      launcher,
    ],
    { encoding: "utf8" },
  );
  if (built.status !== 0) throw new Error(`Native launcher build failed: ${built.stderr}`);
  assets["linux-launcher"] = { path: "linux-launcher", sha256: digest(launcher) };

  const systemBubblewrap = "/usr/bin/bwrap";
  const version = spawnSync(systemBubblewrap, ["--version"], { encoding: "utf8" });
  if (version.status !== 0 || !/^bubblewrap [0-9]+\.[0-9]+/.test(version.stdout.trim())) {
    throw new Error("A compatible system Bubblewrap is required to build the Linux asset");
  }
  const packaged = join(output, "bwrap");
  copyFileSync(systemBubblewrap, packaged);
  assets.bwrap = { path: "bwrap", sha256: digest(packaged) };
  copyFileSync(join(root, "native", "COPYING.bubblewrap"), join(output, "COPYING.bubblewrap"));

  const denyFile = join(output, "deny-file");
  rmSync(denyFile, { force: true });
  writeFileSync(denyFile, "");
  assets["deny-file"] = { path: "deny-file", sha256: digest(denyFile) };
  chmodSync(denyFile, 0o000);
}

writeFileSync(
  join(output, "manifest.json"),
  JSON.stringify(
    {
      format: 1,
      protocol: 1,
      os: process.platform,
      architecture: process.arch,
      assets,
    },
    null,
    2,
  ) + "\n",
);
