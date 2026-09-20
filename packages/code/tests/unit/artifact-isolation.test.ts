import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  createSmokeFixture,
  type SmokeContext,
  requireNativeSmokeConfinement,
} from "../../tooling/artifact/isolation.ts";

const contexts: SmokeContext[] = [];

async function fixture(prefix: string): Promise<SmokeContext> {
  const context = await createSmokeFixture(prefix);
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.cleanup();
});

describe("smoke fixture isolation", () => {
  test("uses an explicit global even when CLARVIS_HOME points elsewhere", async () => {
    const external = await mkdtemp(join(tmpdir(), "clarvis-smoke-external-"));
    try {
      const sentinel = join(external, "settings.json");
      await writeFile(sentinel, '{"sentinel":true}\n', { mode: 0o600 });
      const modulePath = join(import.meta.dir, "../../tooling/artifact/isolation.ts");
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `const {createSmokeFixture}=await import(${JSON.stringify(modulePath)});const c=await createSmokeFixture("clarvis-isolation-sentinel-");process.stdout.write(JSON.stringify({root:c.root,settings:c.paths.settingsFile}));await c.cleanup();`,
        ],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? tmpdir(),
            CLARVIS_HOME: external,
            TMPDIR: process.env.TMPDIR ?? tmpdir(),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const output = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      await child.exited;
      if (child.exitCode !== 0) {
        throw new Error(`smoke child failed (${child.exitCode}): ${error}\n${output}`);
      }
      expect(error).toBe("");
      const result = JSON.parse(output) as { root: string; settings: string };
      expect(result.settings).not.toBe(sentinel);
      expect(relative(result.root, result.settings)).not.toMatch(/^\.\./);
      expect(await readFile(sentinel, "utf8")).toBe('{"sentinel":true}\n');
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  test("rejects reserved and external overrides before a write", async () => {
    const context = await fixture("clarvis-isolation-validation-");
    expect(() => context.environmentFor({ HOME: "/outside" } as never)).toThrow(
      "smoke_override_reserved:HOME",
    );
    expect(() =>
      context.environmentFor({ CLARVIS_INSTALL_ROOT: join(tmpdir(), "outside") }),
    ).toThrow("smoke_override_outside_fixture:CLARVIS_INSTALL_ROOT");
    expect(existsSync(join(context.root, "outside"))).toBe(false);
  });

  test("passes only the owned roots to a real child process", async () => {
    const context = await fixture("clarvis-isolation-subprocess-");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify({home:process.env.HOME,global:process.env.CLARVIS_HOME,workspace:process.env.CLARVIS_WORKSPACE_ROOT,git:process.env.GIT_DIR ?? null}))",
      ],
      { cwd: context.workspace, env: context.environmentFor(), stdout: "pipe", stderr: "pipe" },
    );
    const unregister = context.registerChild(child);
    try {
      const result = JSON.parse(await new Response(child.stdout).text()) as Record<
        string,
        string | null
      >;
      await child.exited;
      expect(child.exitCode).toBe(0);
      expect(result.home).toBe(context.home);
      expect(result.global).toBe(context.global);
      expect(result.workspace).toBe(context.workspace);
      expect(result.git).toBeNull();
    } finally {
      unregister();
    }
  });

  test("cleanup is idempotent and owns the complete root", async () => {
    const context = await fixture("clarvis-isolation-cleanup-");
    const root = context.root;
    await context.cleanup();
    await context.cleanup();
    expect(existsSync(root)).toBe(false);
    contexts.splice(contexts.indexOf(context), 1);
  });

  test("context creation rejects a temporary parent inside operator global state", async () => {
    const external = await mkdtemp(join(tmpdir(), "clarvis-smoke-parent-"));
    const modulePath = join(import.meta.dir, "../../tooling/artifact/isolation.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const {createSmokeContext}=await import(${JSON.stringify(modulePath)});try{await createSmokeContext("clarvis-invalid-parent-");process.exit(2)}catch(error){process.stdout.write(String(error))}`,
      ],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? tmpdir(),
          CLARVIS_HOME: external,
          TMPDIR: external,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    await child.exited;
    if (child.exitCode !== 0) {
      throw new Error(`smoke parent probe failed (${child.exitCode}): ${error}\n${output}`);
    }
    expect(output).toContain("smoke_fixture_parent_overlaps_operator_state");
    await rm(external, { recursive: true, force: true });
  });

  test("native confinement either proves the boundary or reports unavailable", async () => {
    const context = await fixture("clarvis-isolation-native-");
    const outside = await mkdtemp(join(tmpdir(), "clarvis-native-outside-"));
    const outsideFile = join(outside, "blocked");
    try {
      let command: string[];
      try {
        command = await requireNativeSmokeConfinement(
          context,
          [
            process.execPath,
            "-e",
            `const {writeFileSync}=await import("node:fs");writeFileSync(${JSON.stringify(join(context.workspace, "inside"))},"inside");try{writeFileSync(${JSON.stringify(outsideFile)},"outside");process.exit(3)}catch{process.stdout.write("blocked")}`,
          ],
          [join(process.execPath, "..")],
        );
      } catch (error) {
        expect(String(error)).toContain("smoke_native_confinement_unavailable");
        return;
      }
      const child = Bun.spawn(command, {
        cwd: context.workspace,
        env: context.environmentFor(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(errors).toBe("");
      expect(output).toBe("blocked");
      expect(existsSync(join(context.workspace, "inside"))).toBe(true);
      expect(existsSync(outsideFile)).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
