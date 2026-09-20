import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const preload = resolve("tooling/test-runtime/clarvis-home-preload.ts");
const baseEnvironment = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? tmpdir(),
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
};

async function run(
  script: string,
  environment: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "--preload", preload, "-e", script], {
    cwd: process.cwd(),
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("direct entry replaces an inherited CLARVIS_HOME and cleans only its own root", async () => {
  const external = await mkdtemp(join(tmpdir(), "clarvis-preload-external-"));
  try {
    const sentinel = join(external, "settings.json");
    await writeFile(sentinel, "operator-sentinel\n", { mode: 0o600 });
    const result = await run(
      "process.stdout.write(JSON.stringify({global:process.env.CLARVIS_HOME,handoff:process.env.CLARVIS_TEST_HOME_HANDOFF}))",
      { ...baseEnvironment, CLARVIS_HOME: external },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as { global: string; handoff: string };
    expect(output.global).not.toBe(external);
    expect(output.handoff).toBe(output.global);
    expect(existsSync(output.global)).toBe(false);
    expect(await readFile(sentinel, "utf8")).toBe("operator-sentinel\n");
  } finally {
    await rm(external, { recursive: true, force: true });
  }
});

test("an explicit matching handoff is reused by a child and cleaned by the owner", async () => {
  const result = await run(
    `const root=process.env.CLARVIS_HOME;const child=await (async()=>{const p=Bun.spawn([process.execPath,"--preload",${JSON.stringify(preload)},"-e",'process.stdout.write(JSON.stringify({global:process.env.CLARVIS_HOME,handoff:process.env.CLARVIS_TEST_HOME_HANDOFF}))'],{cwd:process.cwd(),env:{PATH:process.env.PATH??"",HOME:process.env.HOME??"/tmp",TMPDIR:process.env.TMPDIR??"/tmp",CLARVIS_HOME:root,CLARVIS_TEST_HOME_HANDOFF:root},stdout:"pipe",stderr:"pipe"});return {code:await p.exited,stdout:await new Response(p.stdout).text(),stderr:await new Response(p.stderr).text()}})();process.stdout.write(JSON.stringify({root,child}))`,
    {
      ...baseEnvironment,
      CLARVIS_HOME: join(tmpdir(), "not-a-handoff-root"),
    },
  );
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const output = JSON.parse(result.stdout) as {
    root: string;
    child: { code: number; stdout: string; stderr: string };
  };
  expect(output.child.code).toBe(0);
  expect(output.child.stderr).toBe("");
  const child = JSON.parse(output.child.stdout) as { global: string; handoff: string };
  expect(child.global).toBe(output.root);
  expect(child.handoff).toBe(output.root);
  expect(existsSync(output.root)).toBe(false);
});
