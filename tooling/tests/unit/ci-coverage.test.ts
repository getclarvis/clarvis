import { afterEach, describe, expect, test } from "bun:test";
import { watch } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  executeCoverageCommand,
  normalizeCoverageExit,
  runCiCoverage,
  type CoverageCommand,
  type CoverageDependencies,
  type CoverageEvent,
} from "../../lib/ci-coverage.ts";
import { readCiWorkspaces } from "../../lib/ci-workspaces.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(names = ["protocol", "code", "new-package"]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clarvis-ci-coverage-"));
  roots.push(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ workspaces: names.map((name) => `packages/${name}`) }),
  );
  for (const name of names) {
    const pkg = join(root, "packages", name);
    await mkdir(join(pkg, "coverage"), { recursive: true });
    await writeFile(join(pkg, "coverage/lcov.info"), "old report");
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({
        name: `@clarvis/${name}`,
        scripts: { "test:coverage": "complete script && architecture contract" },
      }),
    );
  }
  return root;
}

function supervisor(statuses: Record<string, number[]> = {}) {
  const controller = new AbortController();
  const commands: CoverageCommand[] = [];
  const events: CoverageEvent[] = [];
  let clock = 100;
  const deps: CoverageDependencies = {
    bun: "fixture-bun",
    env: { CLARVIS_NATIVE_SANDBOX_CANARY: "1" },
    signal: controller.signal,
    now: () => clock++,
    emit: (event) => events.push(event),
    execute: async (command) => {
      commands.push(command);
      if (command.argv.at(-1) === "test:coverage")
        await expect(access(join(command.cwd, "coverage/lcov.info"))).rejects.toThrow();
      return { code: statuses[basename(command.cwd)]?.shift() ?? 0, signal: null };
    },
  };
  return { deps, controller, commands, events };
}

describe("sequential CI coverage supervisor", () => {
  test("runs each complete script once with package cwd, argv, canary and protocol before the checker", async () => {
    const root = await fixture();
    const { deps, commands, events } = supervisor();
    expect(await runCiCoverage(root, deps)).toEqual({ code: 0, signal: null });
    expect(commands.map((command) => [command.cwd, command.argv])).toEqual([
      [join(root, "packages/protocol"), ["fixture-bun", "run", "test:coverage"]],
      [join(root, "packages/code"), ["fixture-bun", "run", "test:coverage"]],
      [join(root, "packages/new-package"), ["fixture-bun", "run", "test:coverage"]],
      [root, ["fixture-bun", "run", "coverage:check"]],
    ]);
    expect(
      commands.every((command) => command.env === deps.env && command.signal === deps.signal),
    ).toBe(true);
    expect(
      events.filter((event) => event.phase === "end").map((event) => event.durationMs),
    ).toEqual([1, 1, 1, 1]);
  });

  test("recovers each permitted code crash regardless of manifest position and continues remaining packages", async () => {
    for (const status of [132, 134, 139])
      for (const names of [
        ["code", "protocol", "new-package"],
        ["protocol", "code", "new-package"],
        ["protocol", "new-package", "code"],
      ]) {
        const root = await fixture(names);
        const { deps, commands, events } = supervisor({ code: [status, 0] });
        expect((await runCiCoverage(root, deps)).code).toBe(0);
        expect(commands.filter((command) => basename(command.cwd) === "code")).toHaveLength(2);
        expect(commands.at(-1).argv.at(-1)).toBe("coverage:check");
        expect(events.filter((event) => event.phase === "retry")).toHaveLength(1);
        expect(commands).toHaveLength(5);
      }
  });

  test("exhausts exactly three additional attempts and never checks partial coverage", async () => {
    const root = await fixture();
    const { deps, commands, events } = supervisor({ code: [139, 139, 139, 139, 0] });
    expect((await runCiCoverage(root, deps)).code).toBe(139);
    expect(commands.filter((command) => basename(command.cwd) === "code")).toHaveLength(4);
    expect(events.filter((event) => event.phase === "retry")).toHaveLength(3);
    expect(commands.some((command) => command.argv.at(-1) === "coverage:check")).toBe(false);
  });

  test("preserves assertions, cancellation statuses and other packages' signal failures", async () => {
    for (const [name, statuses] of [
      ["code", [1, 3, 130, 143]],
      ["protocol", [132, 134, 139]],
    ] as const)
      for (const status of statuses) {
        const root = await fixture();
        const { deps, commands, events } = supervisor({ [name]: [status, 0] });
        expect((await runCiCoverage(root, deps)).code).toBe(status);
        expect(commands.filter((command) => basename(command.cwd) === name)).toHaveLength(1);
        expect(events.some((event) => event.phase === "retry")).toBe(false);
        expect(commands.some((command) => command.argv.at(-1) === "coverage:check")).toBe(false);
      }
  });

  test("clears stale and failed-attempt reports only in the selected package", async () => {
    const root = await fixture(["code", "protocol"]);
    const { deps } = supervisor();
    let attempt = 0;
    deps.execute = async (command) => {
      if (basename(command.cwd) === "code") {
        await expect(access(join(command.cwd, "coverage/lcov.info"))).rejects.toThrow();
        expect(await readFile(join(root, "packages/protocol/coverage/lcov.info"), "utf8")).toBe(
          "old report",
        );
        await writeFile(join(command.cwd, "coverage/lcov.info"), "partial");
        return { code: ++attempt === 1 ? 132 : 1, signal: null };
      }
      throw new Error("No package or checker may run after the assertion failure");
    };
    expect((await runCiCoverage(root, deps)).code).toBe(1);
    expect(attempt).toBe(2);
  });

  test("awaits the active executor on cancellation and starts neither a retry nor another package", async () => {
    const root = await fixture();
    const { deps, controller, events } = supervisor();
    const started = Promise.withResolvers<void>();
    const child = Promise.withResolvers<{ code: number; signal: null }>();
    let settled = false;
    deps.execute = () => {
      started.resolve();
      return child.promise;
    };
    const running = runCiCoverage(root, deps).finally(() => {
      settled = true;
    });
    await started.promise;
    controller.abort();
    expect(settled).toBe(false);
    child.resolve({ code: 139, signal: null });
    await expect(running).rejects.toThrow();
    expect(events.filter((event) => event.phase === "start")).toHaveLength(1);
    expect(events.some((event) => event.phase === "retry")).toBe(false);
  });

  test("stops between packages and before a retry even if the last child succeeded or crashed", async () => {
    for (const status of [0, 139]) {
      const root = await fixture(["code", "protocol"]);
      const { deps, controller, commands } = supervisor({ code: [status] });
      deps.emit = (event) => {
        if (event.phase === "end") controller.abort();
      };
      await expect(runCiCoverage(root, deps)).rejects.toThrow();
      expect(commands).toHaveLength(1);
    }
  });

  test("returns a global-checker failure after all complete scripts", async () => {
    const root = await fixture();
    const { deps, commands } = supervisor({ [basename(root)]: [1] });
    expect((await runCiCoverage(root, deps)).code).toBe(1);
    expect(commands).toHaveLength(4);
  });

  test("rejects missing scripts, invalid names, duplicate or escaping workspace directories and links", async () => {
    const root = await fixture(["code"]);
    await writeFile(
      join(root, "packages/code/package.json"),
      JSON.stringify({ name: "@clarvis/code", scripts: {} }),
    );
    await expect(readCiWorkspaces(root, "test:coverage")).rejects.toThrow("missing test:coverage");
    await writeFile(
      join(root, "packages/code/package.json"),
      JSON.stringify({ name: "@clarvis/wrong", scripts: { "test:coverage": "true" } }),
    );
    await expect(readCiWorkspaces(root, "test:coverage")).rejects.toThrow(
      "expected workspace name",
    );
    for (const workspaces of [["../escape"], ["/tmp/escape"], ["packages/code/../other"], []]) {
      await writeFile(join(root, "package.json"), JSON.stringify({ workspaces }));
      await expect(readCiWorkspaces(root)).rejects.toThrow();
    }
    await writeFile(
      join(root, "packages/code/package.json"),
      JSON.stringify({ name: "@clarvis/code" }),
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ workspaces: ["packages/code", "packages/code"] }),
    );
    await expect(readCiWorkspaces(root)).rejects.toThrow("Duplicate");
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/link"] }));
    await symlink(join(root, "packages/code"), join(root, "packages/link"));
    await expect(readCiWorkspaces(root)).rejects.toThrow("real directory");
  });
});

describe("real Bun script exit boundary", () => {
  test("normalizes nullable signal exits and preserves ordinary codes", () => {
    expect(normalizeCoverageExit(null, "SIGILL").code).toBe(132);
    expect(normalizeCoverageExit(null, "SIGABRT").code).toBe(134);
    expect(normalizeCoverageExit(null, "SIGSEGV").code).toBe(139);
    expect(normalizeCoverageExit(1, null).code).toBe(1);
    expect(normalizeCoverageExit(null, null).code).toBe(1);
  });

  test("qualifies pinned Bun run conversion for all retry and cancellation signals without product suites", async () => {
    expect(Bun.version).toBe(
      (Bun.TOML.parse(await readFile("mise.toml", "utf8")) as { tools: { bun: string } }).tools.bun,
    );
    const root = await fixture([]);
    for (const [signal, code] of [
      ["ILL", 132],
      ["ABRT", 134],
      ["SEGV", 139],
      ["INT", 130],
      ["TERM", 143],
    ] as const) {
      await writeFile(join(root, "signal.sh"), `kill -${signal} $$\n`);
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ scripts: { "test:coverage": "bash signal.sh && exit 0" } }),
      );
      const result = await executeCoverageCommand({
        argv: [
          "bash",
          "-c",
          'ulimit -c 0; exec "$@"',
          "ci-signal",
          process.execPath,
          "run",
          "test:coverage",
        ],
        cwd: root,
        env: process.env,
        signal: new AbortController().signal,
      });
      expect(result.code).toBe(code);
    }
    for (const code of [0, 1, 3]) {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ scripts: { "test:coverage": `exit ${code}` } }),
      );
      expect(
        (
          await executeCoverageCommand({
            argv: [process.execPath, "run", "test:coverage"],
            cwd: root,
            env: process.env,
            signal: new AbortController().signal,
          })
        ).code,
      ).toBe(code);
    }
  });

  test("cancels a real active child after its observable readiness and waits for exit", async () => {
    const root = await fixture([]);
    await writeFile(
      join(root, "active.ts"),
      `import { watch, writeFileSync } from "node:fs";\nwatch(".", () => {});\nwriteFileSync("ready", "ready");\n`,
    );
    const ready = Promise.withResolvers<void>();
    const watcher = watch(root, (_event, name) => {
      if (name === "ready") ready.resolve();
    });
    const controller = new AbortController();
    const fuse = setTimeout(() => {
      controller.abort();
      ready.reject(new Error("Physical child readiness fuse expired"));
    }, 10_000);
    const child = executeCoverageCommand({
      argv: [process.execPath, "active.ts"],
      cwd: root,
      env: process.env,
      signal: controller.signal,
    });
    try {
      await ready.promise;
      controller.abort();
      expect((await child).code).toBe(143);
    } finally {
      controller.abort();
      await child;
      clearTimeout(fuse);
      watcher.close();
    }
  });
});
