import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { UNIX_SOCKET_PATH_BUDGET_BYTES, ancestorTrust } from "@clarvis/paths";

import {
  createSmokeContext,
  createSmokeFixture,
  type SmokeContext,
} from "../../tooling/artifact/isolation.ts";

const contexts: SmokeContext[] = [];

async function fixture(prefix: string): Promise<SmokeContext> {
  const context = await createSmokeFixture(prefix);
  contexts.push(context);
  return context;
}

/**
 * A parent deep enough that neither a socket directory beneath it nor a socket
 * name survives the endpoint budget; `release` removes the disposable tree.
 */
async function deepParent(): Promise<{ deep: string; release: () => Promise<void> }> {
  const outer = await mkdtemp(join(tmpdir(), "clarvis-smoke-deep-"));
  const deep = join(outer, "x".repeat(60));
  await mkdir(deep, { recursive: true, mode: 0o700 });
  return { deep, release: () => rm(outer, { recursive: true, force: true }) };
}

/**
 * Register a child the lifecycle owner must terminate, recording whether the
 * fixture roots still existed when it was signalled.
 */
function registeredChild(context: SmokeContext, observed: boolean[]): () => void {
  let settle = (): void => undefined;
  const exited = new Promise<number>((resolve) => {
    settle = () => resolve(0);
  });
  return context.registerChild({
    kill: () => {
      observed.push(existsSync(context.root));
      settle();
    },
    exited,
  });
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
        `const {createSmokeContext}=await import(${JSON.stringify(modulePath)});` +
          `const viaParent=await createSmokeContext("clarvis-invalid-parent-",{parentRoot:process.env.CLARVIS_HOME}).then(()=>"accepted",(error)=>String(error));` +
          `const viaCandidates=await createSmokeContext("clarvis-invalid-parent-",{parentCandidates:[process.env.CLARVIS_HOME]}).then(()=>"accepted",(error)=>String(error));` +
          `process.stdout.write(JSON.stringify({viaParent,viaCandidates}))`,
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
    const verdicts = JSON.parse(output) as { viaParent: string; viaCandidates: string };
    expect(verdicts.viaParent).toContain("smoke_fixture_parent_overlaps_operator_state");
    expect(verdicts.viaCandidates).toContain("smoke_fixture_no_usable_parent");
    expect(verdicts.viaCandidates).toContain("smoke_fixture_parent_overlaps_operator_state");
    await rm(external, { recursive: true, force: true });
  });

  test("keeps the fixture outside a deep inherited temporary root and reserves its sockets", async () => {
    const { deep, release } = await deepParent();
    try {
      const context = await createSmokeContext("clarvis-isolation-short-", {
        parentRoot: deep,
      });
      contexts.push(context);
      expect(context.root.startsWith(deep)).toBe(true);
      expect(context.sockets.startsWith(deep)).toBe(false);
      expect(context.sockets.startsWith(context.root)).toBe(false);
      expect(relative(context.root, context.sockets)).toMatch(/^\.\./);
      const socket = context.socketPath("tmux");
      expect(Buffer.byteLength(socket, "utf8")).toBeLessThanOrEqual(UNIX_SOCKET_PATH_BUDGET_BYTES);
      expect(context.writableRoots).toContain(context.root);
      expect(context.writableRoots).toContain(context.sockets);
      expect(ancestorTrust(join(context.root, "state")).trusted).toBe(true);

      const signalled: boolean[] = [];
      const unregister = [registeredChild(context, signalled), registeredChild(context, signalled)];
      await context.cleanup();
      expect(signalled).toEqual([true, true]);
      expect(existsSync(context.root)).toBe(false);
      expect(existsSync(context.sockets)).toBe(false);
      for (const releaseChild of unregister) releaseChild();
      contexts.splice(contexts.indexOf(context), 1);
    } finally {
      await release();
    }
  });

  test("reports a host whose every socket parent is too long for an address", async () => {
    const { deep, release } = await deepParent();
    try {
      const outcome = await createSmokeContext("clarvis-isolation-sockets-", {
        parentCandidates: [deep],
        socketParentCandidates: [deep],
      }).then(
        (context) => {
          contexts.push(context);
          return "accepted";
        },
        (error: unknown) => String(error),
      );
      expect(outcome).toContain("smoke_socket_root_unavailable");
      expect(outcome).toContain("x".repeat(60));
    } finally {
      await release();
    }
  });

  test("names a candidate it refuses, before allocating anything", async () => {
    const { deep, release } = await deepParent();
    try {
      const absent = join(deep, "absent");
      const outcome = await createSmokeContext("clarvis-isolation-refused-", {
        parentCandidates: [absent],
        socketParentCandidates: [absent],
      }).then(
        (context) => {
          contexts.push(context);
          return "accepted";
        },
        (error: unknown) => String(error),
      );
      expect(outcome).toContain("smoke_fixture_no_usable_parent");
      expect(outcome).toContain("smoke_fixture_parent_must_be_a_real_directory");
      expect(outcome).toContain("absent");
    } finally {
      await release();
    }
  });

  test.skipIf(process.getuid?.() === 0)(
    "reports a validated parent that cannot host an allocation",
    async () => {
      const { deep, release } = await deepParent();
      try {
        await chmod(deep, 0o500);
        const outcome = await createSmokeContext("clarvis-isolation-unwritable-", {
          parentCandidates: [deep],
        }).then(
          (context) => {
            contexts.push(context);
            return "accepted";
          },
          (error: unknown) => String(error),
        );
        expect(outcome).toContain("smoke_fixture_no_usable_parent");
        expect(outcome).toContain("short_temporary_root_unavailable");
      } finally {
        await chmod(deep, 0o700);
        await release();
      }
    },
  );

  test("reports a socket address that cannot fit the operating-system budget", async () => {
    const context = await fixture("clarvis-isolation-budget-");
    const overBudget = Array.from({ length: UNIX_SOCKET_PATH_BUDGET_BYTES / 2 }, () => "é").join(
      "",
    );
    expect(() => context.socketPath(overBudget)).toThrow("smoke_socket_path_exceeds_budget");
  });
});
