import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { configurationRoots } from "@clarvis/paths";
import { makeSymlink } from "../helpers/fixtures.ts";
import { callTool, makeConfig } from "../helpers/fixtures.ts";
import { environmentFixture, spyOnProcessEnv } from "../helpers/process-fixtures.ts";
import {
  discoverLinkedGitMetadataPaths,
  discoverToolchains,
  probeBubblewrap,
  probeSandbox,
  probeSeatbelt,
  resolverMounts,
  resolveFilesystemPolicy,
  sandboxCommand,
  systemTemporaryRoots,
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

function withEnvironment<T>(values: Record<string, string | undefined>, callback: () => T): T {
  const env = spyOnProcessEnv(environmentFixture({ ...process.env, ...values }));
  try {
    return callback();
  } finally {
    env.mockRestore();
  }
}

describe("sandboxCommand", () => {
  it("freezes a run policy and changes identity when its effective access changes", () => {
    const input = {
      runId: "run-one",
      placement: "sandbox" as const,
      workspaceRoot: "/workspace",
      temporaryRoots: ["/tmp/run"],
      gitMetadataPaths: ["/git/common"],
      sandbox: { type: "native" as const, filesystem: "workspace-read-only" as const },
    };
    const policy = resolveFilesystemPolicy(input);
    expect(policy).toMatchObject({
      placement: "sandbox",
      readScope: "host-visible",
      writeScope: "declared-roots",
      workspaceAccess: "read-only",
      protectedRoots: [resolve("/workspace"), resolve("/git/common")],
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.temporaryRoots)).toBe(true);
    expect(Object.isFrozen(policy.sandbox)).toBe(true);
    expect(
      resolveFilesystemPolicy({
        ...input,
        sandbox: { type: "native", filesystem: "workspace-write" },
      }).identity,
    ).not.toBe(policy.identity);
    expect(resolveFilesystemPolicy({ ...input, runId: "run-two" }).identity).not.toBe(
      policy.identity,
    );
  });
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

  it("reports an unavailable toolchain without invoking its entrypoint", () => {
    const emptyPath = mkdtempSync(join(tmpdir(), "clarvis-empty-toolchain-"));
    try {
      expect(discoverToolchains(["node"], { PATH: emptyPath })).toEqual([
        expect.objectContaining({
          id: "node",
          available: false,
          error: expect.stringContaining("not found"),
        }),
      ]);
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "preserves direct execution when sandbox is absent",
    () => {
      const spec = sandboxCommand({ command: "echo ok", cwd: "/ws", workspaceRoot: "/ws" });
      expect(spec.file).toBe("sh");
      expect(spec.args).toEqual(["-c", "echo ok"]);
    },
  );

  it("discovers temporary roots that exist on the active host", () => {
    const environmentTemporaryRoot = mkdtempSync(join(tmpdir(), "clarvis-system-tmp-"));
    try {
      const expected =
        process.platform === "win32"
          ? [environmentTemporaryRoot]
          : [...new Set([environmentTemporaryRoot, "/tmp"])];
      expect(systemTemporaryRoots(process.platform, environmentTemporaryRoot)).toEqual(expected);
      expect(systemTemporaryRoots("win32", environmentTemporaryRoot)).toEqual([
        environmentTemporaryRoot,
      ]);
      if (process.platform !== "win32") {
        expect(systemTemporaryRoots(process.platform, "/")).toEqual(["/tmp"]);
      }
    } finally {
      rmSync(environmentTemporaryRoot, { recursive: true, force: true });
    }
  });

  it("exposes the primary temp in env and every compatible temp to native commands", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "clarvis-run-tmp-"));
    try {
      const compatibleRoot = resolve(tmpdir());
      const direct = sandboxCommand({
        command: "true",
        cwd: "/ws",
        workspaceRoot: "/ws",
        temporaryRoots: [temporaryRoot, compatibleRoot],
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
        temporaryRoots: [temporaryRoot, compatibleRoot],
        sandbox: { type: "native" },
        probe: () => ({ backend: "bubblewrap", mode: "fresh-proc" }),
      });
      expect(isolated.options.env).toMatchObject({
        TMPDIR: temporaryRoot,
        TEMP: temporaryRoot,
        TMP: temporaryRoot,
      });
      expect(isolated.args).toContain(realpathSync(temporaryRoot));
      expect(isolated.args).toContain(realpathSync(compatibleRoot));
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
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

  it("fails closed when the native sandbox is optional but unusable", () => {
    expect(() =>
      sandboxCommand({
        command: "echo ok",
        cwd: "/ws",
        workspaceRoot: "/ws",
        sandbox: { type: "native", availability: "optional" },
        probe: () => ({
          backend: "unsupported",
          mode: "unavailable",
          reason: "no native backend",
        }),
        shell: () => ({ flavor: "posix", file: "sh" }),
      }),
    ).toThrow("Native sandbox is required: no native backend");
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
        sandbox: { type: "native", filesystem: "workspace-write" },
        probe: () => ({ backend: "bubblewrap", mode: "fresh-proc" }),
      });
      expect(writable.args.join("\0")).toContain(
        ["--bind", realpathSync(common), realpathSync(common)].join("\0"),
      );

      const readonly = sandboxCommand({
        command: "git status",
        cwd: workspace,
        workspaceRoot: workspace,
        gitMetadataPaths,
        sandbox: { type: "native", filesystem: "workspace-read-only" },
        probe: () => ({ backend: "bubblewrap", mode: "fresh-proc" }),
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
        sandbox: { type: "native", filesystem: "workspace-write" },
        probe: () => ({ backend: "bubblewrap", mode: "fresh-proc" }),
      });
      expect(afterMutation.args).toContain(realpathSync(common));
      expect(afterMutation.args).not.toContain(realpathSync(outside));
      expect(discoverLinkedGitMetadataPaths(workspace)).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not pass provider secrets into a Bubblewrap environment",
    () => {
      withEnvironment({ OPENAI_API_KEY: "sentinel" }, () => {
        const spec = sandboxCommand({
          command: "true",
          cwd: "/workspace/sub",
          workspaceRoot: "/workspace",
          sandbox: {
            type: "native",
            availability: "required",
            filesystem: "workspace-read-only",
            network: "none",
            passEnv: ["OPENAI_API_KEY", "CI"],
          },
          secretEnvNames: ["OPENAI_API_KEY"],
          probe: () => ({ backend: "bubblewrap", mode: "fresh-proc" }),
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
      });
    },
  );

  it("fails closed when the native sandbox is required but unavailable", () => {
    expect(() =>
      sandboxCommand({
        command: "true",
        cwd: "/workspace",
        workspaceRoot: "/workspace",
        sandbox: { type: "native", availability: "required" },
        probe: () => ({
          backend: "unsupported",
          mode: "unavailable",
          reason: "test environment blocks namespaces",
        }),
      }),
    ).toThrow("test environment blocks namespaces");
  });

  it("uses a read-only host proc when a fresh proc mount is blocked", () => {
    const spec = sandboxCommand({
      command: "true",
      cwd: "/workspace",
      workspaceRoot: "/workspace",
      sandbox: { type: "native" },
      probe: () => ({
        backend: "bubblewrap",
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
      try {
        withEnvironment({ PATH: `${join(root, "bin")}:/private/not-mounted:/usr/bin` }, () => {
          const spec = sandboxCommand({
            command: "true",
            cwd: "/workspace",
            workspaceRoot: "/workspace",
            sandbox: { type: "native", runtimePaths: [root] },
            probe: () => ({ backend: "bubblewrap", mode: "fresh-proc" }),
          });
          const sandboxEntries = spec.options.env?.PATH?.split(":") ?? [];
          expect(sandboxEntries[0]).toBe(join(root, "bin"));
          expect(sandboxEntries).toContain("/usr/bin");
          expect(sandboxEntries).toContain("/bin");
          expect(sandboxEntries).not.toContain("/private/not-mounted");
          expect(spec.args).toContain(realpathSync(root));
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
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
      sandbox: { type: "native", network: "none" },
      probe: () => ({ backend: "bubblewrap", mode: "fresh-proc" }),
    });
    expect(spec.args).toContain("--unshare-net");
    for (const mount of resolverMounts()) {
      if (mount !== "--ro-bind") expect(spec.args).not.toContain(mount);
    }
  });

  it("rejects read-only mounts that expose broad host roots", () => {
    for (const path of ["/", "/home", dirname(homedir()), homedir()]) {
      expect(() =>
        sandboxCommand({
          command: "true",
          cwd: "/workspace",
          workspaceRoot: "/workspace",
          sandbox: { type: "native", readOnlyPaths: [path] },
          probe: () => ({ backend: "bubblewrap", mode: "fresh-proc" }),
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
          sandbox: { type: "native", readOnlyPaths: [relative] },
          probe: () => ({ backend: "bubblewrap", mode: "fresh-proc" }),
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
        sandbox: { type: "native", runtimePaths: ["run/socket"] },
        probe: () => ({ backend: "bubblewrap", mode: "fresh-proc" }),
      }),
    ).toThrow("must be absolute");
  });

  it("rejects a read-only mount that contains the workspace", () => {
    expect(() =>
      sandboxCommand({
        command: "true",
        cwd: "/workspace/project",
        workspaceRoot: "/workspace/project",
        sandbox: { type: "native", readOnlyPaths: ["/workspace"] },
        probe: () => ({ backend: "bubblewrap", mode: "fresh-proc" }),
      }),
    ).toThrow("may not contain the workspace");
  });

  it("validates the canonical target of a declared read-only path", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-sandbox-canonical-"));
    const workspace = join(root, "workspace");
    const alias = join(root, "broad-alias");
    mkdirSync(workspace);
    makeSymlink(resolve("/"), alias, "dir");
    expect(() =>
      sandboxCommand({
        command: "true",
        cwd: workspace,
        workspaceRoot: workspace,
        sandbox: { type: "native", readOnlyPaths: [alias] },
        probe: () => ({ backend: "seatbelt", mode: "seatbelt" }),
      }),
    ).toThrow("too broad");
  });

  it("mounts a nested read-only path after the writable workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-workspace-"));
    const sdk = join(workspace, "vendor", "sdk");
    mkdirSync(sdk, { recursive: true });
    const spec = sandboxCommand({
      command: "true",
      cwd: workspace,
      workspaceRoot: workspace,
      sandbox: { type: "native", readOnlyPaths: [sdk] },
      probe: () => ({ backend: "bubblewrap", mode: "fresh-proc" }),
    });
    expect(spec.args.indexOf(realpathSync(workspace))).toBeLessThan(
      spec.args.indexOf(realpathSync(sdk)),
    );
  });

  it("keeps a temp-contained read-only workspace closed and rejects scratch nested inside it", () => {
    const compatibleTemporaryRoot = mkdtempSync(join(tmpdir(), "clarvis-temp-policy-"));
    const workspace = join(compatibleTemporaryRoot, "workspace");
    const scratch = join(compatibleTemporaryRoot, "run-scratch");
    const nestedScratch = join(workspace, "nested-scratch");
    mkdirSync(scratch, { recursive: true });
    mkdirSync(nestedScratch, { recursive: true });
    try {
      expect(() =>
        sandboxCommand({
          command: "true",
          cwd: workspace,
          workspaceRoot: workspace,
          temporaryRoots: [nestedScratch, compatibleTemporaryRoot],
          sandbox: { type: "native", filesystem: "workspace-read-only" },
          probe: () => ({ backend: "bubblewrap", mode: "fresh-proc" }),
        }),
      ).toThrow("Writable temporary root is inside a protected sandbox path");
      const bubblewrap = sandboxCommand({
        command: "true",
        cwd: workspace,
        workspaceRoot: workspace,
        temporaryRoots: [scratch, compatibleTemporaryRoot],
        sandbox: { type: "native", filesystem: "workspace-read-only" },
        probe: () => ({ backend: "bubblewrap", mode: "fresh-proc" }),
      });
      expect(bubblewrap.args.indexOf(realpathSync(compatibleTemporaryRoot))).toBeLessThan(
        bubblewrap.args.indexOf(realpathSync(workspace)),
      );
      expect(bubblewrap.args.indexOf(realpathSync(workspace))).toBeLessThan(
        bubblewrap.args.indexOf(realpathSync(scratch)),
      );

      const seatbelt = sandboxCommand({
        command: "true",
        cwd: workspace,
        workspaceRoot: workspace,
        temporaryRoots: [scratch, compatibleTemporaryRoot],
        sandbox: { type: "native", filesystem: "workspace-read-only" },
        probe: () => ({ backend: "seatbelt", mode: "seatbelt" }),
        shell: () => ({ flavor: "posix", file: "sh" }),
      });
      const profile = seatbelt.args[seatbelt.args.indexOf("-p") + 1]!;
      const keyFor = (path: string): string => {
        const definition = seatbelt.args.find((arg) => arg.endsWith(`=${path}`));
        expect(definition).toBeDefined();
        return definition!.slice(0, definition!.indexOf("="));
      };
      const workspaceKey = keyFor(workspace);
      const scratchKey = keyFor(scratch);
      expect(profile).toContain(`(require-not (subpath (param "${workspaceKey}")))`);
      expect(profile).toContain(`(subpath (param "${scratchKey}"))`);
    } finally {
      rmSync(compatibleTemporaryRoot, { recursive: true, force: true });
    }
  });

  it("compiles a parameterized Seatbelt profile with matching filesystem and network policy", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-seatbelt-profile-"));
    const workspace = join(
      root,
      process.platform === "win32" ? "workspace" : 'workspace ") (allow file-write*) ("',
    );
    const scratch = join(root, "scratch");
    const compatibleTemporaryRoot = join(root, "system-temporary");
    const sdk = join(workspace, "vendor", "sdk");
    const gitMetadata = join(root, "git-common");
    mkdirSync(sdk, { recursive: true });
    mkdirSync(scratch);
    mkdirSync(compatibleTemporaryRoot);
    mkdirSync(gitMetadata);
    const spec = sandboxCommand({
      command: "true",
      cwd: workspace,
      workspaceRoot: workspace,
      gitMetadataPaths: [gitMetadata],
      temporaryRoots: [scratch, compatibleTemporaryRoot],
      sandbox: {
        type: "native",
        filesystem: "workspace-write",
        network: "none",
        readOnlyPaths: [sdk],
      },
      probe: () => ({ backend: "seatbelt", mode: "seatbelt" }),
      shell: () => ({ flavor: "posix", file: "sh" }),
    });
    const profileIndex = spec.args.indexOf("-p");
    const profile = spec.args[profileIndex + 1]!;
    expect(spec.file).toBe("/usr/bin/sandbox-exec");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain("(allow file-read* file-test-existence file-map-executable)");
    expect(profile).toContain("(allow signal (target same-sandbox))");
    expect(profile).toContain("(allow process-info* (target same-sandbox))");
    expect(profile).toContain("(deny network*)");
    expect(profile).not.toContain('(literal "/var/run/mDNSResponder")');
    expect(profile).not.toContain('(literal "/private/var/run/mDNSResponder")');
    expect(profile).toContain("(deny file-write*");
    expect(profile).not.toContain(workspace);
    expect(profile).not.toContain(realpathSync(workspace));
    for (const path of [
      workspace,
      realpathSync(workspace),
      scratch,
      realpathSync(scratch),
      compatibleTemporaryRoot,
      realpathSync(compatibleTemporaryRoot),
      sdk,
      realpathSync(sdk),
      gitMetadata,
      realpathSync(gitMetadata),
    ]) {
      expect(spec.args.some((arg) => arg.endsWith(`=${path}`))).toBe(true);
    }
    expect(spec.args.slice(-3)).toEqual(["sh", "-c", "true"]);
    expect(spec.options.env).toMatchObject({
      HOME: realpathSync(scratch),
      TMPDIR: realpathSync(scratch),
      npm_config_script_shell: "/bin/sh",
    });

    const hostNetwork = sandboxCommand({
      command: "true",
      cwd: workspace,
      workspaceRoot: workspace,
      temporaryRoots: [scratch],
      sandbox: { type: "native", network: "host" },
      probe: () => ({ backend: "seatbelt", mode: "seatbelt" }),
      shell: () => ({ flavor: "posix", file: "sh" }),
    });
    const hostProfile = hostNetwork.args[hostNetwork.args.indexOf("-p") + 1]!;
    expect(hostProfile).toContain("(allow file-read* file-test-existence file-map-executable)");
  });

  it.skipIf(process.platform === "win32")(
    "discovers c-cpp without executing its cc entrypoint",
    () => {
      const root = mkdtempSync(join(tmpdir(), "clarvis-cc-toolchain-"));
      const bin = join(root, "bin");
      const sentinel = join(root, "entrypoint-ran");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "cc"),
        '#!/bin/sh\nprintf invoked > "$(dirname "$0")/../entrypoint-ran"\n',
        { mode: 0o755 },
      );
      try {
        withEnvironment({ PATH: bin }, () => {
          const [found] = discoverToolchains(["c-cpp"]);
          expect(found).toMatchObject({
            id: "c-cpp",
            available: true,
            manager: "custom",
            root: realpathSync(root),
          });
          expect(found).not.toHaveProperty("version");
          expect(existsSync(sentinel)).toBe(false);
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
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
      try {
        withEnvironment({ PATH: `${blocked}:${bin}` }, () => {
          const [found] = discoverToolchains(["bun"]);
          expect(found).toMatchObject({
            available: true,
            logicalPath: join(bin, "bun"),
          });
          expect(found).not.toHaveProperty("version");
        });
      } finally {
        rmSync(blocked, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
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
      backend: "bubblewrap",
      mode: "unavailable",
      reason: "Bubblewrap is supported only on Linux (host platform: darwin)",
    });
  });

  it("reports unavailable when the bwrap executable is missing", () => {
    const probe = probeBubblewrap({
      platform: "linux",
      spawnSync: () => ({ status: null, error: new Error("ENOENT") }),
    });
    expect(probe).toEqual({
      backend: "bubblewrap",
      mode: "unavailable",
      reason: "bwrap executable was not found",
    });
  });

  it("reports unavailable when bwrap --version exits non-zero", () => {
    const probe = probeBubblewrap({ platform: "linux", spawnSync: fakeProbeSpawnSync([1]) });
    expect(probe).toEqual({
      backend: "bubblewrap",
      mode: "unavailable",
      reason: "bwrap executable was not found",
    });
  });

  it("reports fresh-proc when the fresh /proc probe succeeds", () => {
    const probe = probeBubblewrap({ platform: "linux", spawnSync: fakeProbeSpawnSync([0, 0]) });
    expect(probe).toEqual({ backend: "bubblewrap", mode: "fresh-proc" });
  });

  it("falls back to host-proc when only the bound /proc probe succeeds", () => {
    const probe = probeBubblewrap({
      platform: "linux",
      spawnSync: fakeProbeSpawnSync([0, 1, 0]),
    });
    expect(probe).toEqual({ backend: "bubblewrap", mode: "host-proc" });
  });

  it("reports unavailable when neither /proc strategy is usable", () => {
    const probe = probeBubblewrap({
      platform: "linux",
      spawnSync: fakeProbeSpawnSync([0, 1, 1]),
    });
    expect(probe).toEqual({
      backend: "bubblewrap",
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

describe("probeSeatbelt and probeSandbox", () => {
  it("reports Seatbelt unavailable off macOS without spawning", () => {
    const probe = probeSeatbelt({
      platform: "linux",
      spawnSync: () => {
        throw new Error("must not spawn off macOS");
      },
    });
    expect(probe).toEqual({
      backend: "seatbelt",
      mode: "unavailable",
      reason: "Seatbelt is supported only on macOS (host platform: linux)",
    });
  });

  it("requires a successful Seatbelt profile launch", () => {
    expect(probeSeatbelt({ platform: "darwin", spawnSync: () => ({ status: 0 }) })).toEqual({
      backend: "seatbelt",
      mode: "seatbelt",
    });
    expect(probeSeatbelt({ platform: "darwin", spawnSync: () => ({ status: 1 }) })).toEqual({
      backend: "seatbelt",
      mode: "unavailable",
      reason: "sandbox-exec could not apply the Clarvis Seatbelt profile",
    });
  });

  it("dispatches the native backend by platform", () => {
    expect(probeSandbox({ platform: "linux", spawnSync: fakeProbeSpawnSync([0, 0]) })).toEqual({
      backend: "bubblewrap",
      mode: "fresh-proc",
    });
    expect(probeSandbox({ platform: "darwin", spawnSync: () => ({ status: 0 }) })).toEqual({
      backend: "seatbelt",
      mode: "seatbelt",
    });
    expect(probeSandbox({ platform: "win32" })).toEqual({
      backend: "unsupported",
      mode: "unavailable",
      reason: "Native sandboxing is unsupported on host platform: win32",
    });
  });
});

it.skipIf(process.env.CLARVIS_NATIVE_SANDBOX_CANARY !== "1")(
  "enforces the native sandbox against real host resources",
  () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-native-canary-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const declaredReadOnly = join(root, "declared-read-only");
    const nestedReadOnly = join(workspace, "vendor", "sdk");
    const scratch = join(root, "scratch");
    mkdirSync(nestedReadOnly, { recursive: true });
    mkdirSync(outside);
    mkdirSync(declaredReadOnly);
    mkdirSync(scratch);
    const outsideSecret = join(outside, "secret.txt");
    const outsideWrite = join(outside, "escaped.txt");
    const outsideLink = join(workspace, "outside-link");
    const declaredFile = join(declaredReadOnly, "toolchain.txt");
    const nestedFile = join(nestedReadOnly, "nested.txt");
    const hardLink = join(nestedReadOnly, "outside-hard-link.txt");
    writeFileSync(outsideSecret, "sentinel\n");
    linkSync(outsideSecret, hardLink);
    makeSymlink(outside, outsideLink);
    writeFileSync(declaredFile, "toolchain\n");
    writeFileSync(nestedFile, "nested\n");
    try {
      const backend = probeSandbox();
      if (backend.mode === "unavailable") throw new Error(backend.reason);
      const filesystem = sandboxCommand({
        command:
          `printf inside > inside.txt && ` +
          `test "$(/bin/cat "${outsideSecret}")" = sentinel && ` +
          `if printf escaped > "${outsideWrite}" 2>/dev/null; then exit 42; fi && ` +
          `test "$(/bin/cat "${outsideLink}/secret.txt")" = sentinel && ` +
          `if printf escaped > "${outsideLink}/linked.txt" 2>/dev/null; then exit 47; fi`,
        cwd: workspace,
        workspaceRoot: workspace,
        temporaryRoots: [scratch],
        sandbox: { type: "native", availability: "required", network: "none" },
        probe: () => backend,
      });
      const filesystemResult = spawnSync(filesystem.file, filesystem.args, {
        ...filesystem.options,
        encoding: "utf8",
      });
      expect(filesystemResult.status).toBe(0);
      expect(readFileSync(join(workspace, "inside.txt"), "utf8")).toBe("inside");
      expect(() => readFileSync(outsideWrite)).toThrow();

      const readOnlyWorkspace = sandboxCommand({
        command:
          `printf temporary > "$TMPDIR/allowed.txt" && ` +
          `if printf denied > workspace-denied.txt 2>/dev/null; then exit 43; fi`,
        cwd: workspace,
        workspaceRoot: workspace,
        temporaryRoots: [scratch],
        sandbox: {
          type: "native",
          availability: "required",
          filesystem: "workspace-read-only",
          network: "none",
        },
        probe: () => backend,
      });
      const readOnlyResult = spawnSync(
        readOnlyWorkspace.file,
        readOnlyWorkspace.args,
        readOnlyWorkspace.options,
      );
      expect(readOnlyResult.status).toBe(0);
      expect(readFileSync(join(scratch, "allowed.txt"), "utf8")).toBe("temporary");
      expect(() => readFileSync(join(workspace, "workspace-denied.txt"))).toThrow();

      const declaredRoots = sandboxCommand({
        command:
          `test "$(/bin/cat "${declaredFile}")" = toolchain && ` +
          `test "$(/bin/cat "${nestedFile}")" = nested && ` +
          `test "$(/bin/cat "${hardLink}")" = sentinel && ` +
          `if printf denied > "${declaredFile}" 2>/dev/null; then exit 44; fi && ` +
          `if printf denied > "${nestedFile}" 2>/dev/null; then exit 45; fi && ` +
          `if printf denied > "${hardLink}" 2>/dev/null; then exit 46; fi`,
        cwd: workspace,
        workspaceRoot: workspace,
        temporaryRoots: [scratch],
        sandbox: {
          type: "native",
          availability: "required",
          filesystem: "workspace-write",
          network: "none",
          readOnlyPaths: [declaredReadOnly, nestedReadOnly],
        },
        probe: () => backend,
      });
      const declaredResult = spawnSync(declaredRoots.file, declaredRoots.args, {
        ...declaredRoots.options,
        encoding: "utf8",
      });
      expect(declaredResult).toMatchObject({ status: 0 });
      expect(readFileSync(declaredFile, "utf8")).toBe("toolchain\n");
      expect(readFileSync(nestedFile, "utf8")).toBe("nested\n");
      expect(readFileSync(outsideSecret, "utf8")).toBe("sentinel\n");

      const listener = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { data() {} },
      });
      try {
        const runtimeExecutable = realpathSync(process.execPath);
        const runtimeRoot = dirname(dirname(runtimeExecutable));
        const connect =
          `Bun.connect({hostname:"127.0.0.1",port:${listener.port},` +
          `socket:{data(){},open(){process.exit(73)},error(){process.exit(0)}}})` +
          `.catch(()=>process.exit(0));setTimeout(()=>process.exit(0),1000)`;
        const networkCommand = `"${runtimeExecutable}" -e '${connect}'`;
        const runNetwork = (network: "host" | "none") => {
          const spec = sandboxCommand({
            command: networkCommand,
            cwd: workspace,
            workspaceRoot: workspace,
            temporaryRoots: [scratch],
            sandbox: {
              type: "native",
              availability: "required",
              filesystem: "workspace-read-only",
              network,
              runtimePaths: [runtimeRoot],
            },
            probe: () => backend,
          });
          return spawnSync(spec.file, spec.args, spec.options).status;
        };
        expect(runNetwork("host")).toBe(73);
        expect(runNetwork("none")).toBe(0);
      } finally {
        listener.stop(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "allows workspace configuration writes inside a writable native sandbox",
  () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-shell-config-"));
    const workspace = join(root, "workspace");
    const scratch = join(root, "scratch");
    mkdirSync(workspace);
    mkdirSync(scratch);
    const roots = configurationRoots({
      workspaceRoot: workspace,
      globalDir: join(root, "global"),
      home: root,
    });
    mkdirSync(roots.workspace_clarvis);
    const settings = join(roots.workspace_clarvis, "settings.json");
    const source = join(scratch, "source.txt");
    const ordinary = join(workspace, "ordinary.txt");
    const git = join(workspace, ".git");
    mkdirSync(git);
    writeFileSync(join(git, "config"), "original git\n");
    writeFileSync(settings, "original\n");
    writeFileSync(source, "replacement\n");
    try {
      const backend = probeSandbox();
      if (backend.mode === "unavailable") throw new Error(backend.reason);
      const spec = sandboxCommand({
        command:
          `cp '${source}' '${settings}' && ` +
          `mkdir -p '${join(roots.workspace_agents, "skills")}' && ` +
          `printf ordinary > '${ordinary}' && ` +
          `printf changed > '${join(git, "config")}'`,
        cwd: workspace,
        workspaceRoot: workspace,
        temporaryRoots: [scratch],
        sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
        probe: () => backend,
      });
      const result = spawnSync(spec.file, spec.args, {
        ...spec.options,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(settings, "utf8")).toBe("replacement\n");
      expect(readFileSync(join(git, "config"), "utf8")).toBe("changed");
      expect(readFileSync(ordinary, "utf8")).toBe("ordinary");
      expect(existsSync(join(roots.workspace_agents, "skills"))).toBe(true);

      const redirected = join(roots.workspace_clarvis, "redirected");
      makeSymlink(ordinary, redirected);
      expect(() =>
        sandboxCommand({
          command: "true",
          cwd: workspace,
          workspaceRoot: workspace,
          temporaryRoots: [scratch],
          sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
          probe: () => backend,
        }),
      ).not.toThrow();
      rmSync(redirected);

      linkSync(settings, join(workspace, "alias.txt"));
      expect(() =>
        sandboxCommand({
          command: "true",
          cwd: workspace,
          workspaceRoot: workspace,
          temporaryRoots: [scratch],
          sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
          probe: () => backend,
        }),
      ).not.toThrow();
      rmSync(join(workspace, "alias.txt"));
      linkSync(join(git, "config"), join(workspace, "git-alias"));
      expect(() =>
        sandboxCommand({
          command: "true",
          cwd: workspace,
          workspaceRoot: workspace,
          temporaryRoots: [scratch],
          sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
          probe: () => backend,
        }),
      ).not.toThrow();
      rmSync(join(workspace, "git-alias"));
      rmSync(git, { recursive: true });
      makeSymlink(scratch, git, "dir");
      expect(() =>
        sandboxCommand({
          command: "true",
          cwd: workspace,
          workspaceRoot: workspace,
          temporaryRoots: [scratch],
          sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
          probe: () => backend,
        }),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "uses the same broad-read write-limited policy for shell and shell_session with an external cwd",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-shell-policy-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const scratch = join(root, "scratch");
    mkdirSync(workspace);
    mkdirSync(outside);
    mkdirSync(scratch);
    const marker = join(outside, "marker.txt");
    const denied = join(outside, "denied.txt");
    writeFileSync(marker, "outside\n");
    const config = makeConfig(workspace, {
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
      temporaryRoots: [scratch],
    });
    try {
      const direct = await callTool(
        "shell",
        {
          command: `test "$(cat '${marker}')" = outside && if printf denied > '${denied}'; then exit 71; fi && pwd`,
          cwd: outside,
        },
        config,
      );
      expect(direct.isError).toBe(false);
      expect(direct.json.exit_code).toBe(0);
      expect(String(direct.json.stdout).trim()).toBe(outside);
      expect(existsSync(denied)).toBe(false);

      const started = await callTool(
        "shell",
        {
          command: "printf 'READY\\n'; sleep 10",
          cwd: outside,
          ready_when: "READY",
          yield_time_ms: 5000,
        },
        config,
      );
      expect(started.json).toMatchObject({ running: true, ready: true });
      const sessionId = started.json.session_id as string;
      const polled = await callTool(
        "shell_session",
        { action: "poll", session_id: sessionId },
        config,
      );
      expect(String(polled.json.stdout)).toContain("READY");
      const stopped = await callTool(
        "shell_session",
        { action: "stop", session_id: sessionId },
        config,
      );
      expect(stopped.json.termination_confirmed).toBe(true);

      const fileRead = await callTool("read_file", { path: marker }, config);
      expect(fileRead.isError).toBe(false);
      expect(fileRead.text).toContain("outside");
      const fileWrite = await callTool("write_file", { path: denied, content: "denied" }, config);
      expect(fileWrite.isError).toBe(true);
      expect(existsSync(denied)).toBe(false);
    } finally {
      await config.sessionManager.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32" || process.env.CLARVIS_NATIVE_SANDBOX_CANARY !== "1")(
  "exposes host-native temp roots without reopening a temp-contained read-only workspace",
  () => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-native-temp-workspace-"));
    const externalTemporary = mkdtempSync(join(tmpdir(), "clarvis-native-compatible-temp-"));
    const scratch = mkdtempSync(join(tmpdir(), "clarvis-native-run-scratch-"));
    const externalFile = join(externalTemporary, "generated.txt");
    const workspaceFile = join(workspace, "denied.txt");
    try {
      const backend = probeSandbox();
      if (backend.mode === "unavailable") throw new Error(backend.reason);
      const spec = sandboxCommand({
        command:
          `printf compatible > '${externalFile}' && ` +
          `printf scratch > "$TMPDIR/owned.txt" && ` +
          `if printf denied > '${workspaceFile}' 2>/dev/null; then exit 51; fi`,
        cwd: workspace,
        workspaceRoot: workspace,
        temporaryRoots: [scratch, ...systemTemporaryRoots()],
        sandbox: {
          type: "native",
          availability: "required",
          filesystem: "workspace-read-only",
          network: "none",
        },
        probe: () => backend,
      });
      const result = spawnSync(spec.file, spec.args, { ...spec.options, encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(readFileSync(externalFile, "utf8")).toBe("compatible");
      expect(readFileSync(join(scratch, "owned.txt"), "utf8")).toBe("scratch");
      expect(existsSync(workspaceFile)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(externalTemporary, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "darwin" || process.env.CLARVIS_NATIVE_SANDBOX_CANARY !== "1")(
  "runs the installed Apple Git without triggering the developer-tools fallback",
  () => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-seatbelt-git-"));
    try {
      const backend = probeSandbox();
      if (backend.mode === "unavailable") throw new Error(backend.reason);
      const run = (command: string) => {
        const spec = sandboxCommand({
          command,
          cwd: workspace,
          workspaceRoot: workspace,
          sandbox: {
            type: "native",
            availability: "required",
            filesystem: "workspace-read-only",
            network: "none",
          },
          probe: () => backend,
        });
        return spawnSync(spec.file, spec.args, {
          ...spec.options,
          encoding: "utf8",
        });
      };

      for (const path of ["/var/select/developer_dir", "/var/db/xcode_select_link"]) {
        const selector = run(`/usr/bin/readlink ${path}`);
        expect(selector.status).toBe(0);
        expect(selector.stdout.trim()).toMatch(/^\/.+/);
      }

      const result = run("/usr/bin/git --version");
      expect(result.stderr).not.toContain("No developer tools were found");
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^git version /);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "darwin" || process.env.CLARVIS_NATIVE_SANDBOX_CANARY !== "1")(
  "installs and executes a packed package bootstrap inside Seatbelt without network",
  () => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-seatbelt-npm-"));
    const scratch = mkdtempSync(join(tmpdir(), "clarvis-seatbelt-npm-scratch-"));
    try {
      const backend = probeSandbox();
      if (backend.mode === "unavailable") throw new Error(backend.reason);
      const node = discoverToolchains(["node"])[0];
      if (node?.available !== true || node.logicalPath === undefined) {
        throw new Error(node?.error ?? "the Node.js toolchain is unavailable");
      }
      const appleSiliconHomebrewNpm = "/opt/homebrew/bin/npm";
      const npm = existsSync(appleSiliconHomebrewNpm)
        ? appleSiliconHomebrewNpm
        : join(dirname(node.logicalPath), "npm");
      const fixture = join(scratch, "fixture");
      mkdirSync(fixture);
      writeFileSync(
        join(fixture, "package.json"),
        `${JSON.stringify({
          name: "clarvis-sandbox-bootstrap-fixture",
          version: "1.0.0",
          bin: { "clarvis-sandbox-bootstrap": "bin.mjs" },
          files: ["bin.mjs"],
        })}\n`,
      );
      const fixtureBin = join(fixture, "bin.mjs");
      writeFileSync(
        fixtureBin,
        [
          "#!/usr/bin/env node",
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'import { resolve } from "node:path";',
          "const [target] = process.argv.slice(2);",
          'if (target === undefined) throw new Error("target directory is required");',
          "const output = resolve(process.cwd(), target);",
          "mkdirSync(output, { recursive: true });",
          "writeFileSync(`${output}/package.json`, `${JSON.stringify({ name: target })}\\n`);",
          "",
        ].join("\n"),
      );
      chmodSync(fixtureBin, 0o755);
      const packed = spawnSync(
        npm,
        ["pack", fixture, "--pack-destination", scratch, "--json", "--ignore-scripts"],
        {
          cwd: workspace,
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, npm_config_cache: join(scratch, "host-cache") },
        },
      );
      expect(packed.status, `host npm pack failed: ${packed.error?.message ?? packed.stderr}`).toBe(
        0,
      );
      const [artifact] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
      if (artifact === undefined) throw new Error("host npm pack returned no artifact");
      const { filename } = artifact;
      const tarball = join(scratch, filename);

      const npmArgs = [
        "exec",
        "--yes",
        "--offline",
        `--cache=${join(scratch, "sandbox-cache")}`,
        `--package=${tarball}`,
        "--loglevel=error",
        "--",
        "clarvis-sandbox-bootstrap",
        "generated",
      ];

      const spec = sandboxCommand({
        command: [npm, ...npmArgs].join(" "),
        cwd: workspace,
        workspaceRoot: workspace,
        temporaryRoots: [scratch, ...systemTemporaryRoots()],
        sandbox: {
          type: "native",
          availability: "required",
          filesystem: "workspace-write",
          network: "none",
          ...(node.root === undefined ? {} : { runtimePaths: [node.root] }),
        },
        probe: () => backend,
      });
      const result = spawnSync(spec.file, spec.args, {
        ...spec.options,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(
        result.status,
        `Seatbelt npm exec failed: ${result.error?.message ?? result.stderr}`,
      ).toBe(0);
      expect(
        JSON.parse(readFileSync(join(workspace, "generated", "package.json"), "utf8")),
      ).toMatchObject({ name: "generated" });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

/**
 * The unsandboxed path is not a fallback nobody takes: it remains the explicit
 * no-sandbox posture and the optional fallback on an unavailable backend. The
 * native canary above proves the isolated branch; these prove the bare branch
 * withholds configured credentials too.
 */
describe("sandboxCommand — withholding credentials without a sandbox", () => {
  it("subtracts the named variables and keeps everything else", () => {
    withEnvironment({ CLARVIS_TEST_SECRET: "sentinel", CLARVIS_TEST_KEEP: "ordinary" }, () => {
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
    withEnvironment({ CLARVIS_TEST_SECRET: "sentinel" }, () => {
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

  it("does not fall back to a secret-bearing host spawn when optional isolation is unusable", () => {
    withEnvironment({ CLARVIS_TEST_SECRET: "sentinel" }, () => {
      expect(() =>
        sandboxCommand({
          command: "true",
          cwd: "/ws",
          workspaceRoot: "/ws",
          sandbox: { type: "native", availability: "optional" },
          secretEnvNames: ["CLARVIS_TEST_SECRET"],
          probe: () => ({
            backend: "unsupported",
            mode: "unavailable",
            reason: "no namespaces here",
          }),
          shell: () => ({ flavor: "posix", file: "sh" }),
        }),
      ).toThrow("Native sandbox is required: no namespaces here");
    });
  });

  it("passes the environment through untouched when no names are given", () => {
    withEnvironment({ CLARVIS_TEST_SECRET: "sentinel" }, () => {
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
