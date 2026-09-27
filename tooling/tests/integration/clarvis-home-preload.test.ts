import { expect, test } from "bun:test";
import { existsSync, rmSync, watch } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { acquireTestHome } from "../../test-runtime/clarvis-test-home.ts";

const preload = resolve("tooling/test-runtime/clarvis-home-preload.ts");
const repositoryRoot = resolve(import.meta.dir, "../../..");

type RunResult = { code: number; stdout: string; stderr: string };

async function fixture<T>(
  run: (paths: {
    root: string;
    temporary: string;
    external: string;
    environment: Record<string, string>;
  }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "clarvis-preload-fixture-"));
  const temporary = join(root, "temporary");
  const external = join(root, "external");
  const home = join(root, "home");
  await Promise.all([mkdir(temporary), mkdir(external), mkdir(home)]);
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    CLARVIS_HOME: external,
  };
  try {
    return await run({ root, temporary, external, environment });
  } finally {
    await chmod(temporary, 0o700);
    await rm(root, { recursive: true, force: true });
  }
}

async function runTests(
  files: string[],
  environment: Record<string, string>,
  options: string[] = [],
  cwd = repositoryRoot,
): Promise<RunResult> {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--no-isolate",
      "--preload",
      preload,
      "--timeout",
      "60000",
      ...options,
      ...files,
    ],
    {
      cwd,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const deadline = setTimeout(() => child.kill(), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(deadline);
    child.kill();
    await child.exited;
  }
}

function roots(output: string): string[] {
  return [...output.matchAll(/TEST_ROOT:(\S+)/g)].map((match) => match[1]);
}

async function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return;
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      if (existsSync(path)) finish();
    });
    const deadline = setTimeout(() => {
      watcher.close();
      reject(new Error(`timed out waiting for ${path}`));
    }, 10_000);
    function finish(): void {
      clearTimeout(deadline);
      watcher.close();
      resolve();
    }
    if (existsSync(path)) finish();
  });
}

async function writeCase(file: string, body: string): Promise<void> {
  await writeFile(
    file,
    `import { test, expect, afterAll, beforeAll } from "bun:test";\nimport { existsSync, writeFileSync } from "node:fs";\n${body}\n`,
  );
}

test("two files share one root through both file hooks, then the runner removes it", async () => {
  await fixture(async ({ root, temporary, external, environment }) => {
    const sentinel = join(external, "settings.json");
    await writeFile(sentinel, "fixture-sentinel\n");
    const files = [join(root, "first.test.ts"), join(root, "second.test.ts")];
    for (const [index, file] of files.entries()) {
      await writeCase(
        file,
        `const root = process.env.CLARVIS_HOME!;\ntest("file ${index}", () => { expect(existsSync(root)).toBe(true); console.log("TEST_ROOT:" + root); });\nafterAll(() => { expect(existsSync(root)).toBe(true); writeFileSync(root + "/hook-${index}", "done"); console.log("FILE_HOOK:${index}"); });`,
      );
    }
    const result = await runTests(files, environment);
    expect(result.code).toBe(0);
    expect(roots(result.stdout)).toHaveLength(2);
    expect(new Set(roots(result.stdout)).size).toBe(1);
    expect(result.stdout).toContain("FILE_HOOK:0");
    expect(result.stdout).toContain("FILE_HOOK:1");
    expect(roots(result.stdout)[0]).not.toBe(external);
    expect(existsSync(roots(result.stdout)[0])).toBe(false);
    expect(await readdir(temporary)).toEqual([]);
    expect(await readFile(sentinel, "utf8")).toBe("fixture-sentinel\n");
  });
});

test.each(["first", "second"])(
  "assertion failure in the %s file still removes the root",
  async (failedFile) => {
    await fixture(async ({ root, temporary, environment }) => {
      const files = [join(root, "first.test.ts"), join(root, "second.test.ts")];
      for (const [index, file] of files.entries()) {
        await writeCase(
          file,
          `test("file ${index}", () => { console.log("TEST_ROOT:" + process.env.CLARVIS_HOME); expect(${failedFile === (index === 0 ? "first" : "second")}).toBe(false); });`,
        );
      }
      const result = await runTests(files, environment);
      expect(result.code).not.toBe(0);
      expect(roots(result.stdout)).toHaveLength(2);
      expect(await readdir(temporary)).toEqual([]);
    });
  },
);

test.each(["setup", "import"])("%s failure still removes the root", async (phase) => {
  await fixture(async ({ root, temporary, environment }) => {
    const file = join(root, "failure.test.ts");
    const body =
      phase === "setup"
        ? `console.log("TEST_ROOT:" + process.env.CLARVIS_HOME); beforeAll(() => { throw new Error("setup refused"); }); test("setup", () => {});`
        : `console.log("TEST_ROOT:" + process.env.CLARVIS_HOME); throw new Error("import refused");`;
    await writeCase(file, body);
    const result = await runTests([file], environment);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`${phase} refused`);
    expect(await readdir(temporary)).toEqual([]);
  });
});

test("a handoff child leaves the owner's root alive", async () => {
  await fixture(async ({ root, temporary, environment }) => {
    const childFile = join(root, "handoff-child.test.ts");
    await writeCase(
      childFile,
      `test("child", () => { expect(existsSync(process.env.CLARVIS_HOME!)).toBe(true); console.log("TEST_ROOT:" + process.env.CLARVIS_HOME); });`,
    );
    const ownerFile = join(root, "owner.test.ts");
    await writeCase(
      ownerFile,
      `test("owner", async () => { const root = process.env.CLARVIS_HOME!; console.log("TEST_ROOT:" + root); const child = Bun.spawn([process.execPath, "test", "--no-isolate", "--preload", ${JSON.stringify(preload)}, ${JSON.stringify(childFile)}, "--timeout", "60000"], { cwd: ${JSON.stringify(repositoryRoot)}, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR!, TMP: process.env.TMP!, TEMP: process.env.TEMP!, CLARVIS_HOME: root, CLARVIS_TEST_HOME_HANDOFF: root }, stdout: "pipe", stderr: "pipe" }); const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); expect(code).toBe(0); expect(stdout).toContain("TEST_ROOT:" + root); expect(existsSync(root)).toBe(true); });`,
    );
    const result = await runTests([ownerFile], environment);
    expect(result.code).toBe(0);
    expect(await readdir(temporary)).toEqual([]);
  });
});

test("two concurrent commands own distinct roots", async () => {
  await fixture(async ({ root, temporary, environment }) => {
    const file = join(root, "concurrent.test.ts");
    await writeCase(
      file,
      `test("root", async () => { const root = process.env.CLARVIS_HOME!; writeFileSync(process.env.READY_FILE!, root); await new Response(Bun.stdin.stream()).text(); expect(existsSync(root)).toBe(true); });`,
    );
    const ready = [join(root, "first.ready"), join(root, "second.ready")];
    const children = ready.map((marker) =>
      Bun.spawn(
        [
          process.execPath,
          "test",
          "--no-isolate",
          "--preload",
          preload,
          "--timeout",
          "60000",
          file,
        ],
        {
          cwd: repositoryRoot,
          env: { ...environment, READY_FILE: marker },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    );
    const outputs = children.map((child) =>
      Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]),
    );
    try {
      await Promise.all(ready.map(waitForFile));
      const owned = await Promise.all(ready.map((marker) => readFile(marker, "utf8")));
      expect(owned[0]).not.toBe(owned[1]);
      expect(owned.every(existsSync)).toBe(true);
      await children[0].stdin?.end();
      const [firstCode, [firstStdout, firstStderr]] = await Promise.all([
        children[0].exited,
        outputs[0],
      ]);
      expect(firstCode).toBe(0);
      expect(firstStdout).toBeDefined();
      expect(firstStderr).not.toContain("error:");
      expect(existsSync(owned[0])).toBe(false);
      expect(existsSync(owned[1])).toBe(true);
      await children[1].stdin?.end();
      expect(await children[1].exited).toBe(0);
      await outputs[1];
      expect(existsSync(owned[1])).toBe(false);
    } finally {
      for (const child of children) {
        child.kill();
        await child.exited;
      }
    }
    expect(await readdir(temporary)).toEqual([]);
  });
});

test("the standalone lifecycle reports a refused cleanup and remains retryable", () => {
  let attempts = 0;
  const home = acquireTestHome((path, options) => {
    attempts += 1;
    if (attempts === 1) throw new Error("simulated refusal");
    rmSync(path, options);
  }, {});
  try {
    expect(() => home.cleanup()).toThrow(home.root);
    expect(existsSync(home.root)).toBe(true);
    home.cleanup();
    home.cleanup();
    expect(attempts).toBe(2);
    expect(existsSync(home.root)).toBe(false);
  } finally {
    rmSync(home.root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "runner cleanup refusal fails and retains prior assertion failure: %s",
  async (priorFailure) => {
    await fixture(async ({ root, temporary, environment }) => {
      const file = join(root, "refusal.test.ts");
      await writeCase(
        file,
        `import { chmodSync } from "node:fs";\nimport { dirname } from "node:path";\ntest("refusal", () => { const root = process.env.CLARVIS_HOME!; console.log("TEST_ROOT:" + root); chmodSync(dirname(root), 0o500); expect(${priorFailure}).toBe(false); });`,
      );
      const result = await runTests([file], environment);
      await chmod(temporary, 0o700);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("clarvis test home cleanup failed for");
      expect(result.stderr).toContain(roots(result.stdout)[0]);
      if (priorFailure) expect(result.stderr).toContain("expect(received).toBe(expected)");
      expect(existsSync(roots(result.stdout)[0])).toBe(true);
    });
  },
);

test("coverage output remains at the configured destination and the root is removed", async () => {
  await fixture(async ({ root, temporary, environment }) => {
    const file = join(root, "coverage.test.ts");
    await writeCase(
      file,
      `test("coverage", () => { console.log("TEST_ROOT:" + process.env.CLARVIS_HOME); expect(true).toBe(true); });`,
    );
    const coverage = join(root, "coverage");
    const result = await runTests(
      [file],
      environment,
      ["--coverage", "--coverage-reporter=lcov", `--coverage-dir=${coverage}`],
      root,
    );
    expect(result.code).toBe(0);
    expect(existsSync(join(coverage, "lcov.info"))).toBe(true);
    expect(await readdir(temporary)).toEqual([]);
  });
});
