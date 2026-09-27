import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runTestTemporaryAudit,
  TestCommandExecutionError,
  type AuditedCommand,
  type TemporaryAuditEvent,
} from "../../lib/test-temporary-audit.ts";

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function parent(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "clarvis-audit-unit-"));
  parents.push(path);
  return path;
}

function command(env: NodeJS.ProcessEnv = {}): AuditedCommand {
  return {
    argv: ["test-bun", "run", "test"],
    cwd: "/fixture",
    env,
    signal: new AbortController().signal,
  };
}

test("passes a clean command with isolated environment and removes its area", async () => {
  const base = await parent();
  const events: TemporaryAuditEvent[] = [];
  let area = "";
  const input = command({ CLARVIS_TEST_HOME_HANDOFF: "/someone-else", HOME: "/fixture-home" });
  const result = await runTestTemporaryAudit(input, "package test", {
    parent: base,
    emit: (event) => events.push(event),
    execute: async (received) => {
      area = received.env.TMPDIR;
      expect(received.argv).toBe(input.argv);
      expect(received.cwd).toBe(input.cwd);
      expect(received.signal).toBe(input.signal);
      expect(received.env.TMP).toBe(area);
      expect(received.env.TEMP).toBe(area);
      expect(received.env.NODE_DISABLE_COMPILE_CACHE).toBe("1");
      expect(received.env.HOME).toBe("/fixture-home");
      expect(received.env.CLARVIS_TEST_HOME_HANDOFF).toBeUndefined();
      expect(await readdir(area)).toEqual([]);
      return { code: 0, signal: null };
    },
  });
  expect(result.code).toBe(0);
  expect(input.env.CLARVIS_TEST_HOME_HANDOFF).toBe("/someone-else");
  expect(events.map((event) => event.phase)).toEqual(["result", "observation", "containment"]);
  expect(events[1]?.remaining).toEqual([]);
  expect(existsSync(area)).toBe(false);
});

test("reports residue before containment and preserves a failed command status", async () => {
  for (const code of [0, 7]) {
    const base = await parent();
    const sibling = join(base, "sentinel");
    await writeFile(sibling, "keep");
    const events: TemporaryAuditEvent[] = [];
    let area = "";
    const result = await runTestTemporaryAudit(command(), `attempt ${code}`, {
      parent: base,
      emit: (event) => {
        events.push(event);
        if (event.phase === "observation") {
          expect(event.remaining).toEqual(["leak"]);
          expect(existsSync(area)).toBe(true);
        }
      },
      execute: async (received) => {
        area = received.env.TMPDIR;
        await mkdir(join(area, "leak"));
        return { code, signal: null };
      },
    });
    expect(result.code).toBe(code === 0 ? 1 : code);
    expect(events[0]?.exit?.code).toBe(code);
    expect(existsSync(area)).toBe(false);
    expect(await readFile(sibling, "utf8")).toBe("keep");
  }
});

test("a settled spawn failure is contained; unconfirmed dependent exit retains its area", async () => {
  const base = await parent();
  const roots: string[] = [];
  for (const settled of [true, false]) {
    const events: TemporaryAuditEvent[] = [];
    await expect(
      runTestTemporaryAudit(command(), `spawn ${settled}`, {
        parent: base,
        emit: (event) => {
          events.push(event);
          if (event.root) roots.push(event.root);
        },
        execute: async (received) => {
          await writeFile(join(received.env.TMPDIR, "partial"), "x");
          throw new TestCommandExecutionError("spawn failed", settled);
        },
      }),
    ).rejects.toThrow("spawn failed");
    expect(events.at(-1)?.phase).toBe("containment");
    expect(events.at(-1)?.error).toBe(
      settled ? undefined : "dependent process exit unconfirmed; area retained",
    );
  }
  expect(await readdir(base)).toHaveLength(1);
  expect(existsSync(roots.at(-1))).toBe(true);
});

test("simultaneous commands receive distinct areas and cannot remove a sibling", async () => {
  const base = await parent();
  const bothStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const roots: string[] = [];
  const run = (label: string) =>
    runTestTemporaryAudit(command(), label, {
      parent: base,
      emit: () => {},
      execute: async (received) => {
        roots.push(received.env.TMPDIR);
        if (roots.length === 2) bothStarted.resolve();
        await release.promise;
        return { code: 0, signal: null };
      },
    });
  const first = run("first");
  const second = run("second");
  await bothStarted.promise;
  expect(new Set(roots).size).toBe(2);
  expect(roots.every((root) => existsSync(root))).toBe(true);
  release.resolve();
  expect((await Promise.all([first, second])).map((result) => result.code)).toEqual([0, 0]);
  expect(await readdir(base)).toEqual([]);
});
