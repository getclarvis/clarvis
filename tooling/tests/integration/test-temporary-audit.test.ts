import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ root: string; temporary: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "clarvis-audit-integration-"));
  roots.push(root);
  const temporary = join(root, "temporary");
  const home = join(root, "home");
  await Promise.all([mkdir(temporary), mkdir(home)]);
  return { root, temporary, home };
}

async function run(argv: string[], temporary: string, home: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("CLARVIS_")),
  ) as NodeJS.ProcessEnv;
  env.HOME = home;
  env.TMPDIR = temporary;
  env.TMP = temporary;
  env.TEMP = temporary;
  const child = Bun.spawn([process.execPath, "run", "test:cleanup", "--", ...argv], {
    cwd: resolve(import.meta.dir, "../../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    child.kill();
    await child.exited;
  }
}

test("a real Bun test preload and physical fixture empty their audit area", async () => {
  const { root, temporary, home } = await fixture();
  const file = join(root, "clean.test.ts");
  const helper = resolve(import.meta.dir, "../../../packages/code/tests/helpers/tracked-temp.ts");
  await writeFile(
    file,
    `import { test, expect } from "bun:test"; import { openTempDir } from ${JSON.stringify(helper)}; test("owned", () => { const root = openTempDir("clarvis-audit-case-"); expect(root.length).toBeGreaterThan(0); });`,
  );
  const result = await run([process.execPath, "test", file, "--timeout", "60000"], temporary, home);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('"phase":"observation","remaining":[]');
  expect(await readdir(temporary)).toEqual([]);
});

test("an otherwise passing child with a temporary residue fails before containment", async () => {
  const { temporary, home } = await fixture();
  const result = await run(
    [
      process.execPath,
      "-e",
      'require("node:fs").mkdirSync(require("node:path").join(require("node:os").tmpdir(), "leak"))',
    ],
    temporary,
    home,
  );
  expect(result.code).toBe(1);
  expect(result.stdout).toContain('"phase":"result","exit":{"code":0');
  expect(result.stdout).toContain('"phase":"observation","remaining":["leak"]');
  expect(await readdir(temporary)).toEqual([]);
});
