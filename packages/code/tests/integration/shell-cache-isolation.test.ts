import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openTempDir } from "../helpers/tracked-temp.ts";

const pkgRoot = join(import.meta.dir, "..", "..");

/**
 * The probe, as a standalone module: it has to run in a **fresh** process to
 * mean anything.
 *
 * @remarks `resolveShell()` memoizes with `??=`, so it can only be poisoned
 *   while its cache is still cold. Anything already warm in this suite's
 *   process — and by the time the integration files run, plenty is — would make
 *   an in-process assertion pass no matter what the code did. Every import is
 *   absolute so the script resolves from a temp directory.
 */
function probeSource(): string {
  return [
    `const platform = await import(${JSON.stringify(join(pkgRoot, "src/adapters/platform.ts"))});`,
    `const real = process.platform;`,
    `Object.defineProperty(process, "platform", { value: "win32", configurable: true });`,
    `await platform.readClipboardImage(undefined, async () => ({`,
    `  exitCode: 1, stdout: Buffer.alloc(0), stderr: "", timedOut: false,`,
    `  cancelled: false, outputExceeded: false,`,
    `}));`,
    `Object.defineProperty(process, "platform", { value: real, configurable: true });`,
    `const shell = await import(${JSON.stringify(join(pkgRoot, "src/adapters/local-shell.ts"))});`,
    `const r = await shell.runLocalBash("printf probe-ok", { cwd: ${JSON.stringify(pkgRoot)} });`,
    `process.stdout.write(JSON.stringify({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }));`,
  ].join("\n");
}

test.skipIf(process.platform === "win32")(
  "the Windows clipboard path does not pin PowerShell for every later command",
  () => {
    const file = join(openTempDir("clarvis-shell-cache-"), "probe.ts");
    writeFileSync(file, probeSource());
    const run = Bun.spawnSync(["bun", file], { cwd: pkgRoot });
    expect(run.stderr.toString()).toBe("");
    expect(JSON.parse(run.stdout.toString())).toEqual({
      exitCode: 0,
      stdout: "probe-ok",
      stderr: "",
    });
  },
);
