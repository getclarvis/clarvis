import { describe, expect, it } from "bun:test";
import {
  existsSync,
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
import { makeSymlink } from "../helpers/fixtures.ts";
import {
  discoverLinkedGitMetadataPaths,
  discoverToolchains,
  probeBubblewrap,
  probeSandbox,
  probeSeatbelt,
  resolverMounts,
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
      expect(isolated.args).toContain(temporaryRoot);
      expect(isolated.args).toContain(compatibleRoot);
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

  it("falls back explicitly when the native sandbox is optional but unusable", () => {
    const spec = sandboxCommand({
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
    });
    expect(spec.file).toBe("sh");
    expect(spec.sandboxed).toBe(false);
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
      const old = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sentinel";
      try {
        const spec = sandboxCommand({
          command: "true",
          cwd: "/workspace/sub",
          workspaceRoot: "/workspace",
          sandbox: {
            type: "native",
            availability: "required",
            filesystem: "workspace-read-only",
            network: "none",
            passEnv: ["CI"],
          },
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
      } finally {
        if (old === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = old;
      }
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
      const previous = process.env.PATH;
      process.env.PATH = `${join(root, "bin")}:/private/not-mounted:/usr/bin`;
      try {
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
    expect(spec.args.indexOf(workspace)).toBeLessThan(spec.args.indexOf(sdk));
  });

  it("keeps a temp-contained read-only workspace closed while nested run scratch stays writable", () => {
    const compatibleTemporaryRoot = mkdtempSync(join(tmpdir(), "clarvis-temp-policy-"));
    const workspace = join(compatibleTemporaryRoot, "workspace");
    const scratch = join(workspace, "run-scratch");
    mkdirSync(scratch, { recursive: true });
    try {
      const bubblewrap = sandboxCommand({
        command: "true",
        cwd: workspace,
        workspaceRoot: workspace,
        temporaryRoots: [scratch, compatibleTemporaryRoot],
        sandbox: { type: "native", filesystem: "workspace-read-only" },
        probe: () => ({ backend: "bubblewrap", mode: "fresh-proc" }),
      });
      expect(bubblewrap.args.indexOf(compatibleTemporaryRoot)).toBeLessThan(
        bubblewrap.args.indexOf(workspace),
      );
      expect(bubblewrap.args.indexOf(workspace)).toBeLessThan(bubblewrap.args.indexOf(scratch));

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
    expect(profile).toContain(
      "(deny file-read* file-test-existence file-map-executable file-write*)",
    );
    expect(profile).toContain("(allow signal (target same-sandbox))");
    expect(profile).toContain("(allow process-info* (target same-sandbox))");
    expect(profile).toContain('(literal "/etc")');
    expect(profile).toContain('(subpath "/etc")');
    expect(profile).toContain('(literal "/var")');
    expect(profile).toContain('(subpath "/var/db")');
    expect(profile).toContain('(subpath "/private/var/db")');
    expect(profile).toContain('(subpath "/var/select")');
    expect(profile).toContain('(subpath "/private/var/select")');
    expect(profile).toContain('(subpath "/opt/homebrew")');
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
    expect(hostProfile).toContain('(literal "/var/run/mDNSResponder")');
    expect(hostProfile).toContain('(literal "/private/var/run/mDNSResponder")');
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
      const previous = process.env.PATH;
      process.env.PATH = bin;
      try {
        const [found] = discoverToolchains(["c-cpp"]);
        expect(found).toMatchObject({
          id: "c-cpp",
          available: true,
          manager: "custom",
          root: realpathSync(root),
        });
        expect(found).not.toHaveProperty("version");
        expect(existsSync(sentinel)).toBe(false);
      } finally {
        process.env.PATH = previous;
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
      const previous = process.env.PATH;
      process.env.PATH = `${blocked}:${bin}`;
      try {
        const [found] = discoverToolchains(["bun"]);
        expect(found).toMatchObject({
          available: true,
          logicalPath: join(bin, "bun"),
        });
        expect(found).not.toHaveProperty("version");
      } finally {
        process.env.PATH = previous;
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
    const scratch = join(workspace, ".tmp");
    mkdirSync(nestedReadOnly, { recursive: true });
    mkdirSync(outside);
    mkdirSync(declaredReadOnly);
    mkdirSync(scratch);
    const outsideSecret = join(outside, "secret.txt");
    const outsideWrite = join(outside, "escaped.txt");
    const outsideLink = join(workspace, "outside-link");
    const declaredFile = join(declaredReadOnly, "toolchain.txt");
    const nestedFile = join(nestedReadOnly, "nested.txt");
    writeFileSync(outsideSecret, "sentinel\n");
    makeSymlink(outside, outsideLink);
    writeFileSync(declaredFile, "toolchain\n");
    writeFileSync(nestedFile, "nested\n");
    try {
      const backend = probeSandbox();
      if (backend.mode === "unavailable") throw new Error(backend.reason);
      const processInspection =
        backend.mode === "host-proc"
          ? ""
          : `if /bin/ps -p ${process.pid} -o pid= 2>/dev/null | /usr/bin/grep -q '[0-9]'; then exit 48; fi && `;
      const filesystem = sandboxCommand({
        command:
          `printf inside > inside.txt && ` +
          `if kill -0 ${process.pid} 2>/dev/null; then exit 40; fi && ` +
          processInspection +
          `if /bin/cat "${outsideSecret}" >/dev/null 2>&1; then exit 41; fi && ` +
          `if printf escaped > "${outsideWrite}" 2>/dev/null; then exit 42; fi && ` +
          `if /bin/cat "${outsideLink}/secret.txt" >/dev/null 2>&1; then exit 46; fi && ` +
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
          `if printf denied > "${declaredFile}" 2>/dev/null; then exit 44; fi && ` +
          `if printf denied > "${nestedFile}" 2>/dev/null; then exit 45; fi`,
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

it.skipIf(process.platform === "win32" || process.env.CLARVIS_NATIVE_SANDBOX_CANARY !== "1")(
  "exposes host-native temp roots without reopening a temp-contained read-only workspace",
  () => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-native-temp-workspace-"));
    const externalTemporary = mkdtempSync(join(tmpdir(), "clarvis-native-compatible-temp-"));
    const scratch = join(workspace, "run-scratch");
    const externalFile = join(externalTemporary, "generated.txt");
    const workspaceFile = join(workspace, "denied.txt");
    mkdirSync(scratch);
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
  "downloads and executes a package bootstrap inside Seatbelt",
  () => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-seatbelt-npm-"));
    const scratch = mkdtempSync(join(tmpdir(), "clarvis-seatbelt-npm-scratch-"));
    const deniedScratch = mkdtempSync(join(tmpdir(), "clarvis-seatbelt-npm-denied-"));
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
      const preflightArgs = [
        "view",
        "create-vite",
        "version",
        "--registry=https://registry.npmjs.org/",
        "--fetch-retries=0",
        "--fetch-timeout=20000",
        "--loglevel=error",
      ];
      const host = spawnSync(npm, preflightArgs, {
        cwd: workspace,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, npm_config_cache: join(scratch, "host-cache") },
      });
      expect(host.status, `host registry preflight failed: ${host.stderr}`).toBe(0);

      const npmArgs = [
        "exec",
        "--yes",
        "--fetch-retries=0",
        "--fetch-timeout=20000",
        "--loglevel=error",
        "--",
        "create-vite",
        "generated",
        "--template",
        "vanilla",
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
          network: "host",
          ...(node.root === undefined ? {} : { runtimePaths: [node.root] }),
        },
        probe: () => backend,
      });
      const result = spawnSync(spec.file, spec.args, {
        ...spec.options,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status, `Seatbelt npm fetch failed: ${result.stderr}`).toBe(0);
      expect(
        JSON.parse(readFileSync(join(workspace, "generated", "package.json"), "utf8")),
      ).toMatchObject({ name: "generated" });

      const denied = sandboxCommand({
        command: [npm, ...preflightArgs].join(" "),
        cwd: workspace,
        workspaceRoot: workspace,
        temporaryRoots: [deniedScratch, ...systemTemporaryRoots()],
        sandbox: {
          type: "native",
          availability: "required",
          filesystem: "workspace-write",
          network: "none",
          ...(node.root === undefined ? {} : { runtimePaths: [node.root] }),
        },
        probe: () => backend,
      });
      const deniedResult = spawnSync(denied.file, denied.args, {
        ...denied.options,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(deniedResult.error).toBeUndefined();
      expect(deniedResult.status).not.toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
      rmSync(deniedScratch, { recursive: true, force: true });
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
        sandbox: { type: "native", availability: "optional" },
        secretEnvNames: ["CLARVIS_TEST_SECRET"],
        probe: () => ({
          backend: "unsupported",
          mode: "unavailable",
          reason: "no namespaces here",
        }),
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
