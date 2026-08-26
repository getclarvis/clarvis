import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { makeSymlink } from "../helpers/fixtures.ts";
import {
  discoverLinkedGitMetadataPaths,
  discoverToolchains,
  probeBubblewrap,
  resolverMounts,
  sandboxCommand,
  TOOLCHAIN_COMMANDS,
} from "../../src/sandbox.ts";

/** A fake `spawnSync` scripted by call order: `bwrap --version`, then a
 * `fresh-proc` probe, then a `host-proc` probe. */
function fakeProbeSpawnSync(statuses: ReadonlyArray<number | null>) {
  let call = 0;
  return (): { status: number | null; error?: Error } => {
    const status = statuses[call] ?? null;
    call += 1;
    return { status };
  };
}

describe("sandboxCommand", () => {
  it("includes the extended language toolchain catalog", () => {
    expect(TOOLCHAIN_COMMANDS).toMatchObject({
      deno: ["deno"],
      php: ["php", "composer"],
      zig: ["zig"],
      "c-cpp": ["cc", "c++", "gcc", "g++", "clang", "clang++"],
      kotlin: ["kotlin", "kotlinc"],
      swift: ["swift", "swiftc"],
    });
  });

  it.skipIf(process.platform === "win32")(
    "preserves direct execution when sandbox is absent",
    () => {
      const spec = sandboxCommand({ command: "echo ok", cwd: "/ws", workspaceRoot: "/ws" });
      expect(spec.file).toBe("sh");
      expect(spec.args).toEqual(["-c", "echo ok"]);
    },
  );

  it("exposes an explicit run temporary root to unsandboxed and Bubblewrap commands", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "clarvis-run-tmp-"));
    const direct = sandboxCommand({
      command: "true",
      cwd: "/ws",
      workspaceRoot: "/ws",
      temporaryRoot,
    });
    expect(direct.options.env).toMatchObject({
      TMPDIR: temporaryRoot,
      TEMP: temporaryRoot,
      TMP: temporaryRoot,
    });

    const isolated = sandboxCommand({
      command: "true",
      cwd: "/workspace",
      workspaceRoot: "/workspace",
      temporaryRoot,
      sandbox: { type: "bubblewrap" },
      probe: () => ({ mode: "fresh-proc" }),
    });
    expect(isolated.options.env).toMatchObject({
      TMPDIR: temporaryRoot,
      TEMP: temporaryRoot,
      TMP: temporaryRoot,
    });
    expect(isolated.args).toContain(temporaryRoot);
  });

  it("emits the resolved shell's own invocation when sandbox is absent", () => {
    const posix = sandboxCommand({
      command: "echo ok",
      cwd: "/ws",
      workspaceRoot: "/ws",
      shell: () => ({
        flavor: "posix",
        file: "sh",
      }),
    });
    expect(posix.file).toBe("sh");
    expect(posix.args).toEqual(["-c", "echo ok"]);

    const win = sandboxCommand({
      command: "echo ok",
      cwd: "/ws",
      workspaceRoot: "/ws",
      shell: () => ({
        flavor: "powershell",
        file: "powershell.exe",
      }),
    });
    expect(win.file).toBe("powershell.exe");
    expect(win.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(Buffer.from(win.args[3]!, "base64").toString("utf16le").endsWith("\necho ok")).toBe(
      true,
    );
  });

  it("falls back explicitly when Bubblewrap is optional but unusable", () => {
    const spec = sandboxCommand({
      command: "echo ok",
      cwd: "/ws",
      workspaceRoot: "/ws",
      sandbox: { type: "bubblewrap", availability: "optional" },
      shell: () => ({ flavor: "posix", file: "sh" }),
    });
    expect(["sh", "bwrap"]).toContain(spec.file);
  });

  it.skipIf(process.platform === "win32")(
    "mounts a linked worktree's common Git directory with the workspace posture",
    () => {
      const root = mkdtempSync(join(tmpdir(), "clarvis-sandbox-linked-git-"));
      const workspace = join(root, "checkout");
      const common = join(root, "primary", ".git");
      const gitDir = join(common, "worktrees", "review");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(gitDir, { recursive: true });
      writeFileSync(join(workspace, ".git"), `gitdir: ${gitDir}\n`);
      writeFileSync(join(gitDir, "commondir"), "../..\n");
      writeFileSync(join(gitDir, "gitdir"), `${join(workspace, ".git")}\n`);
      const gitMetadataPaths = discoverLinkedGitMetadataPaths(workspace);

      const writable = sandboxCommand({
        command: "git status",
        cwd: workspace,
        workspaceRoot: workspace,
        gitMetadataPaths,
        sandbox: { type: "bubblewrap", filesystem: "workspace-write" },
        probe: () => ({ mode: "fresh-proc" }),
      });
      expect(writable.args.join("\0")).toContain(
        ["--bind", realpathSync(common), realpathSync(common)].join("\0"),
      );

      const readonly = sandboxCommand({
        command: "git status",
        cwd: workspace,
        workspaceRoot: workspace,
        gitMetadataPaths,
        sandbox: { type: "bubblewrap", filesystem: "workspace-read-only" },
        probe: () => ({ mode: "fresh-proc" }),
      });
      expect(readonly.args.join("\0")).toContain(
        ["--ro-bind", realpathSync(common), realpathSync(common)].join("\0"),
      );

      const outside = join(root, "operator-secrets");
      mkdirSync(outside);
      writeFileSync(join(workspace, ".git"), `gitdir: ${outside}\n`);
      const afterMutation = sandboxCommand({
        command: "git status",
        cwd: workspace,
        workspaceRoot: workspace,
        gitMetadataPaths,
        sandbox: { type: "bubblewrap", filesystem: "workspace-write" },
        probe: () => ({ mode: "fresh-proc" }),
      });
      expect(afterMutation.args).toContain(realpathSync(common));
      expect(afterMutation.args).not.toContain(realpathSync(outside));
      expect(discoverLinkedGitMetadataPaths(workspace)).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not pass provider secrets into a Bubblewrap environment",
    () => {
      const old = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sentinel";
      try {
        const spec = sandboxCommand({
          command: "true",
          cwd: "/workspace/sub",
          workspaceRoot: "/workspace",
          sandbox: {
            type: "bubblewrap",
            availability: "required",
            filesystem: "workspace-read-only",
            network: "none",
            passEnv: ["CI"],
          },
          probe: () => ({ mode: "fresh-proc" }),
        });
        expect(spec.file).toBe("bwrap");
        expect(spec.options.env?.OPENAI_API_KEY).toBeUndefined();
        expect(spec.args).toContain("--unshare-net");
        expect(spec.args).toContain("--ro-bind");
        expect(spec.args.slice(-6)).toEqual([
          "--chdir",
          "/workspace/sub",
          "--",
          "sh",
          "-c",
          "true",
        ]);
      } finally {
        if (old === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = old;
      }
    },
  );

  it("fails closed when Bubblewrap is required but unavailable", () => {
    expect(() =>
      sandboxCommand({
        command: "true",
        cwd: "/workspace",
        workspaceRoot: "/workspace",
        sandbox: { type: "bubblewrap", availability: "required" },
        probe: () => ({ mode: "unavailable", reason: "test environment blocks namespaces" }),
      }),
    ).toThrow("test environment blocks namespaces");
  });

  it("uses a read-only host proc when a fresh proc mount is blocked", () => {
    const spec = sandboxCommand({
      command: "true",
      cwd: "/workspace",
      workspaceRoot: "/workspace",
      sandbox: { type: "bubblewrap" },
      probe: () => ({
        mode: "host-proc",
      }),
    });
    const proc = spec.args.indexOf("/proc");
    expect(spec.args.slice(proc - 1, proc + 2)).toEqual(["--ro-bind", "/proc", "/proc"]);
  });

  it.skipIf(process.platform === "win32")(
    "keeps mounted runtime bins in PATH and drops inaccessible host entries",
    () => {
      const root = mkdtempSync(join(tmpdir(), "clarvis-runtime-"));
      mkdirSync(join(root, "bin"));
      const previous = process.env.PATH;
      process.env.PATH = `${join(root, "bin")}:/private/not-mounted:/usr/bin`;
      try {
        const spec = sandboxCommand({
          command: "true",
          cwd: "/workspace",
          workspaceRoot: "/workspace",
          sandbox: { type: "bubblewrap", runtimePaths: [root] },
          probe: () => ({ mode: "fresh-proc" }),
        });
        expect(spec.options.env?.PATH).toBe(`${join(root, "bin")}:/usr/bin`);
        expect(spec.args).toContain(root);
      } finally {
        process.env.PATH = previous;
      }
    },
  );

  it("carries the DNS resolver into a networked sandbox when it lives outside /etc", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-resolver-"));
    const runDir = join(root, "run", "systemd", "resolve");
    mkdirSync(runDir, { recursive: true });
    const target = join(runDir, "stub-resolv.conf");
    writeFileSync(target, "nameserver 127.0.0.53\n");
    const link = join(root, "resolv.conf");
    makeSymlink(target, link);

    const realTarget = realpathSync(target);
    expect(resolverMounts(link)).toEqual(["--ro-bind", realTarget, realTarget]);
  });

  it("adds no resolver mount when /etc already carries the file, or it is missing", () => {
    expect(resolverMounts("/etc/hosts")).toEqual([]);
    expect(resolverMounts(join(tmpdir(), "clarvis-absent-resolv.conf"))).toEqual([]);
  });

  it("skips the resolver entirely when the sandbox has no network", () => {
    const spec = sandboxCommand({
      command: "true",
      cwd: "/workspace",
      workspaceRoot: "/workspace",
      sandbox: { type: "bubblewrap", network: "none" },
      probe: () => ({ mode: "fresh-proc" }),
    });
    expect(spec.args).toContain("--unshare-net");
    for (const mount of resolverMounts()) {
      if (mount !== "--ro-bind") expect(spec.args).not.toContain(mount);
    }
  });

  it("rejects read-only mounts that expose broad host roots", () => {
    for (const path of ["/", "/home", homedir()]) {
      expect(() =>
        sandboxCommand({
          command: "true",
          cwd: "/workspace",
          workspaceRoot: "/workspace",
          sandbox: { type: "bubblewrap", readOnlyPaths: [path] },
          probe: () => ({ mode: "fresh-proc" }),
        }),
      ).toThrow("too broad");
    }
  });

  /**
   * The check exists because `readOnlyPaths` and `runtimePaths` are the one
   * sandbox input that does not arrive through `resolveSandboxPath`: they come
   * from settings, so a relative entry reaches `sandboxCommand` unresolved.
   * `resolve()` would then silently interpret it against the *host's* cwd and
   * mount whatever that happened to be, so refusing is the only safe reading.
   * Every other suite feeds paths that were already absolute, which is what
   * left this arm uncovered.
   */
  it("refuses a relative read-only mount rather than resolving it against the host cwd", () => {
    for (const relative of ["vendor/sdk", "./vendor", "../escape"]) {
      expect(() =>
        sandboxCommand({
          command: "true",
          cwd: "/workspace",
          workspaceRoot: "/workspace",
          sandbox: { type: "bubblewrap", readOnlyPaths: [relative] },
          probe: () => ({ mode: "fresh-proc" }),
        }),
      ).toThrow("must be absolute");
    }
  });

  it("applies the same rule to runtimePaths, which share the mount loop", () => {
    expect(() =>
      sandboxCommand({
        command: "true",
        cwd: "/workspace",
        workspaceRoot: "/workspace",
        sandbox: { type: "bubblewrap", runtimePaths: ["run/socket"] },
        probe: () => ({ mode: "fresh-proc" }),
      }),
    ).toThrow("must be absolute");
  });

  it("rejects a read-only mount that contains the workspace", () => {
    expect(() =>
      sandboxCommand({
        command: "true",
        cwd: "/workspace/project",
        workspaceRoot: "/workspace/project",
        sandbox: { type: "bubblewrap", readOnlyPaths: ["/workspace"] },
        probe: () => ({ mode: "fresh-proc" }),
      }),
    ).toThrow("may not contain the workspace");
  });

  it("mounts a nested read-only path after the writable workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-workspace-"));
    const sdk = join(workspace, "vendor", "sdk");
    mkdirSync(sdk, { recursive: true });
    const spec = sandboxCommand({
      command: "true",
      cwd: workspace,
      workspaceRoot: workspace,
      sandbox: { type: "bubblewrap", readOnlyPaths: [sdk] },
      probe: () => ({ mode: "fresh-proc" }),
    });
    expect(spec.args.indexOf(workspace)).toBeLessThan(spec.args.indexOf(sdk));
  });

  it.skipIf(process.platform === "win32")(
    "discovers a private generic toolchain without depending on mise",
    () => {
      const root = mkdtempSync(join(tmpdir(), "clarvis-bun-toolchain-"));
      const bin = join(root, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "bun"), "#!/bin/sh\necho 9.9.9\n", { mode: 0o755 });
      const previous = process.env.PATH;
      process.env.PATH = bin;
      try {
        const [found] = discoverToolchains(["bun"]);
        expect(found).toMatchObject({
          id: "bun",
          available: true,
          manager: "custom",
          root: realpathSync(root),
          version: "9.9.9",
        });
      } finally {
        process.env.PATH = previous;
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "ignores a non-executable file that shadows a later PATH candidate",
    () => {
      const blocked = mkdtempSync(join(tmpdir(), "clarvis-blocked-toolchain-"));
      const root = mkdtempSync(join(tmpdir(), "clarvis-executable-toolchain-"));
      const bin = join(root, "bin");
      mkdirSync(bin);
      writeFileSync(join(blocked, "bun"), "not executable\n", { mode: 0o644 });
      writeFileSync(join(bin, "bun"), "#!/bin/sh\necho 8.8.8\n", { mode: 0o755 });
      const previous = process.env.PATH;
      process.env.PATH = `${blocked}:${bin}`;
      try {
        const [found] = discoverToolchains(["bun"]);
        expect(found).toMatchObject({
          available: true,
          logicalPath: join(bin, "bun"),
          version: "8.8.8",
        });
      } finally {
        process.env.PATH = previous;
      }
    },
  );
});

describe("probeBubblewrap", () => {
  it("reports unavailable on a non-Linux platform without spawning anything", () => {
    const probe = probeBubblewrap({
      platform: "darwin",
      spawnSync: () => {
        throw new Error("must not spawn on a non-Linux platform");
      },
    });
    expect(probe).toEqual({
      mode: "unavailable",
      reason: "Bubblewrap is supported only on Linux (host platform: darwin)",
    });
  });

  it("reports unavailable when the bwrap executable is missing", () => {
    const probe = probeBubblewrap({
      platform: "linux",
      spawnSync: () => ({ status: null, error: new Error("ENOENT") }),
    });
    expect(probe).toEqual({ mode: "unavailable", reason: "bwrap executable was not found" });
  });

  it("reports unavailable when bwrap --version exits non-zero", () => {
    const probe = probeBubblewrap({ platform: "linux", spawnSync: fakeProbeSpawnSync([1]) });
    expect(probe).toEqual({ mode: "unavailable", reason: "bwrap executable was not found" });
  });

  it("reports fresh-proc when the fresh /proc probe succeeds", () => {
    const probe = probeBubblewrap({ platform: "linux", spawnSync: fakeProbeSpawnSync([0, 0]) });
    expect(probe).toEqual({ mode: "fresh-proc" });
  });

  it("falls back to host-proc when only the bound /proc probe succeeds", () => {
    const probe = probeBubblewrap({
      platform: "linux",
      spawnSync: fakeProbeSpawnSync([0, 1, 0]),
    });
    expect(probe).toEqual({ mode: "host-proc" });
  });

  it("reports unavailable when neither /proc strategy is usable", () => {
    const probe = probeBubblewrap({
      platform: "linux",
      spawnSync: fakeProbeSpawnSync([0, 1, 1]),
    });
    expect(probe).toEqual({
      mode: "unavailable",
      reason: "bwrap cannot create the namespaces or mounts required by Clarvis",
    });
  });

  it("never caches an injected probe", () => {
    let calls = 0;
    const spawnSync = (): { status: number | null; error?: Error } => {
      calls += 1;
      return { status: null, error: new Error("ENOENT") };
    };
    probeBubblewrap({ platform: "linux", spawnSync });
    probeBubblewrap({ platform: "linux", spawnSync });
    expect(calls).toBe(2);
  });
});

/**
 * The unsandboxed path is not a fallback nobody takes: it is what macOS and
 * Windows always take, and what Linux takes without bubblewrap. The sandbox test
 * above proves the bwrap branch withholds credentials; these prove the branch
 * that actually runs on the maintainer's own machine does too.
 */
describe("sandboxCommand — withholding credentials without a sandbox", () => {
  const withEnv = <T>(vars: Record<string, string>, fn: () => T): T => {
    const old = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
      return fn();
    } finally {
      for (const [k, v] of old) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it("subtracts the named variables and keeps everything else", () => {
    withEnv({ CLARVIS_TEST_SECRET: "sentinel", CLARVIS_TEST_KEEP: "ordinary" }, () => {
      const spec = sandboxCommand({
        command: "true",
        cwd: "/ws",
        workspaceRoot: "/ws",
        secretEnvNames: ["CLARVIS_TEST_SECRET"],
        shell: () => ({ flavor: "posix", file: "sh" }),
      });
      expect(spec.options.env?.CLARVIS_TEST_SECRET).toBeUndefined();
      expect(spec.options.env?.CLARVIS_TEST_KEEP).toBe("ordinary");
    });
  });

  it("leaves the real process environment untouched", () => {
    withEnv({ CLARVIS_TEST_SECRET: "sentinel" }, () => {
      sandboxCommand({
        command: "true",
        cwd: "/ws",
        workspaceRoot: "/ws",
        secretEnvNames: ["CLARVIS_TEST_SECRET"],
        shell: () => ({ flavor: "posix", file: "sh" }),
      });
      expect(process.env.CLARVIS_TEST_SECRET).toBe("sentinel");
    });
  });

  it("also scrubs when a sandbox is configured but unavailable and optional", () => {
    // The degraded path is the dangerous one: the operator believes a sandbox is
    // in force, and the command is in fact running straight on the host.
    withEnv({ CLARVIS_TEST_SECRET: "sentinel" }, () => {
      const spec = sandboxCommand({
        command: "true",
        cwd: "/ws",
        workspaceRoot: "/ws",
        sandbox: { type: "bubblewrap", availability: "optional" },
        secretEnvNames: ["CLARVIS_TEST_SECRET"],
        probe: () => ({ mode: "unavailable", reason: "no namespaces here" }),
        shell: () => ({ flavor: "posix", file: "sh" }),
      });
      expect(spec.file).toBe("sh");
      expect(spec.options.env?.CLARVIS_TEST_SECRET).toBeUndefined();
    });
  });

  it("passes the environment through untouched when no names are given", () => {
    withEnv({ CLARVIS_TEST_SECRET: "sentinel" }, () => {
      const spec = sandboxCommand({
        command: "true",
        cwd: "/ws",
        workspaceRoot: "/ws",
        shell: () => ({ flavor: "posix", file: "sh" }),
      });
      expect(spec.options.env?.CLARVIS_TEST_SECRET).toBe("sentinel");
    });
  });
});
