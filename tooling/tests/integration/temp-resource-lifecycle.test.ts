import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const helper = resolve("packages/code/tests/helpers/tracked-temp.ts");

test("two files in one Bun runner each release their acquired root, including on assertion failure", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "clarvis-temp-lifecycle-"));
  try {
    const temporary = join(fixture, "temporary");
    const home = join(fixture, "home");
    await Promise.all([mkdir(temporary), mkdir(home)]);
    for (const failed of [false, true]) {
      const files = [join(fixture, "first.test.ts"), join(fixture, "second.test.ts")];
      for (const [index, file] of files.entries()) {
        await writeFile(
          file,
          `import { test, expect } from "bun:test";\nimport { openTempDir } from ${JSON.stringify(helper)};\ntest("file ${index}", () => { const root = openTempDir("clarvis-owned-file-"); console.log("OWNED_ROOT:" + root); expect(${failed && index === 1 ? "false" : "true"}).toBe(true); });\n`,
        );
      }
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("CLARVIS_")),
      ) as Record<string, string>;
      env.HOME = home;
      env.TMPDIR = temporary;
      env.TMP = temporary;
      env.TEMP = temporary;
      const child = Bun.spawn(
        [process.execPath, "test", "--no-isolate", "--timeout", "60000", ...files],
        {
          cwd: process.cwd(),
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        const roots = [...stdout.matchAll(/OWNED_ROOT:(\S+)/g)].map((match) => match[1]);
        expect(roots).toHaveLength(2);
        expect(new Set(roots).size).toBe(2);
        expect(roots.every((root) => !existsSync(root))).toBe(true);
        expect(await readdir(temporary)).toEqual([]);
        expect(code === 0).toBe(!failed);
        if (failed) expect(stderr).toContain("expect(received).toBe(expected)");
      } finally {
        child.kill();
        await child.exited;
      }
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
