import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve, sep } from "node:path";
import type { LaunchSpec, SandboxBackend } from "../backend.ts";
import { SandboxSetupError } from "../diagnostics.ts";
import type { ExecutionPolicy } from "../policy.ts";

const SYSTEM_BWRAP = ["/usr/bin/bwrap", "/bin/bwrap"] as const;
const NATIVE_ROOT = fileURLToPath(new URL("../../assets/native/", import.meta.url));

function nativeAssets(): { launcher: string; packagedBubblewrap: string; denyFile: string } {
  const manifestPath = resolve(NATIVE_ROOT, "manifest.json");
  let manifest: {
    format?: number;
    protocol?: number;
    os?: string;
    architecture?: string;
    assets?: Record<string, { path: string; sha256: string }>;
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
  } catch {
    throw new SandboxSetupError("sandbox_unavailable", "Native sandbox asset manifest unavailable");
  }
  if (
    manifest.format !== 1 ||
    manifest.protocol !== 1 ||
    manifest.os !== "linux" ||
    manifest.architecture !== process.arch
  ) {
    throw new SandboxSetupError(
      "sandbox_unavailable",
      "Native sandbox asset manifest is incompatible",
    );
  }
  const verify = (name: string) => {
    const asset = manifest.assets?.[name];
    if (!asset || asset.path !== name || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
      throw new SandboxSetupError("sandbox_setup_failed", `Invalid native ${name} identity`);
    }
    const file = resolve(NATIVE_ROOT, name);
    if (!existsSync(file) || !lstatSync(file).isFile()) {
      throw new SandboxSetupError("sandbox_unavailable", `Native ${name} asset unavailable`);
    }
    const actual =
      name === "deny-file"
        ? (() => {
            const entry = lstatSync(file);
            if (entry.size !== 0 || (entry.mode & 0o7777) !== 0) {
              throw new SandboxSetupError("sandbox_setup_failed", "Invalid deny-file permissions");
            }
            return createHash("sha256").digest("hex");
          })()
        : createHash("sha256").update(readFileSync(file)).digest("hex");
    if (actual !== asset.sha256) {
      throw new SandboxSetupError("sandbox_setup_failed", `Native ${name} asset hash mismatch`);
    }
    return file;
  };
  return {
    launcher: verify("linux-launcher"),
    packagedBubblewrap: verify("bwrap"),
    denyFile: verify("deny-file"),
  };
}

function findBubblewrap(packagedBubblewrap: string, preferPackaged: boolean): string {
  const candidates = preferPackaged
    ? [packagedBubblewrap, ...SYSTEM_BWRAP]
    : [...SYSTEM_BWRAP, packagedBubblewrap];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const canonical = realpathSync(candidate);
    if (
      candidate !== packagedBubblewrap &&
      !canonical.startsWith("/usr/") &&
      !canonical.startsWith("/bin/")
    )
      continue;
    if (!lstatSync(canonical).isFile()) continue;
    const probe = spawnSync(canonical, ["--version"], { encoding: "utf8", timeout: 2000 });
    if (probe.status === 0 && /^bubblewrap [0-9]+\.[0-9]+/.test(probe.stdout.trim())) {
      return canonical;
    }
  }
  throw new SandboxSetupError("sandbox_unavailable", "Trusted Bubblewrap executable unavailable");
}

function nestedWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root === sep ? root : `${root}${sep}`);
}

function enforceSource(source: string, label: string): string {
  if (!isAbsolute(source))
    throw new SandboxSetupError("sandbox_setup_failed", `${label} is relative`);
  if (!existsSync(source))
    throw new SandboxSetupError("sandbox_setup_failed", `${label} is missing`);
  return realpathSync(source);
}

function probeBoundary(launcher: string, bwrap: string, network: ExecutionPolicy["network"]): void {
  const truePath = ["/usr/bin/true", "/bin/true"].find(existsSync);
  if (!truePath) {
    throw new SandboxSetupError("sandbox_unavailable", "System probe executable unavailable");
  }
  const args = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/",
    "/",
  ];
  if (network === "disabled") args.push("--unshare-net");
  args.push("--dev", "/dev", "--proc", "/proc");
  args.push("--remount-ro", "/", "--", truePath);
  const result = spawnSync(
    launcher,
    [network === "disabled" ? "--network-disabled" : "--network-enabled", bwrap, ...args],
    { encoding: "utf8", timeout: 3000 },
  );
  if (result.status !== 0) {
    throw new SandboxSetupError(
      "sandbox_unavailable",
      "Bubblewrap namespaces or seccomp are unavailable",
    );
  }
}

/** Bubblewrap launch backend. The host owns all sources and the child only receives argv. */
export class BubblewrapBackend implements SandboxBackend {
  readonly name = "bubblewrap" as const;
  readonly capabilities = {
    pidNamespace: true,
    mountNamespace: true,
    ipcNamespace: true,
    networkIsolation: true,
  } as const;
  private readonly provenBoundaries = new Set<string>();

  constructor(private readonly preferPackagedBubblewrap = false) {}

  prepare(
    policy: ExecutionPolicy,
    child: {
      file: string;
      args: readonly string[];
      cwd: string;
      env: Readonly<Record<string, string>>;
    },
  ): LaunchSpec {
    if (process.platform !== "linux") {
      throw new SandboxSetupError("sandbox_unavailable", "Bubblewrap requires Linux");
    }
    if (policy.mode !== "sandbox") {
      throw new SandboxSetupError("sandbox_setup_failed", "Bubblewrap requires sandbox mode");
    }
    const assets = nativeAssets();
    const bwrap = findBubblewrap(assets.packagedBubblewrap, this.preferPackagedBubblewrap);
    const directoryMounts: { source: string; target: string; writable: boolean }[] = [];
    for (const directory of [policy.homeRoot, ...policy.installationRoots]) {
      const canonical = enforceSource(directory, "runtime root");
      if (!lstatSync(canonical).isDirectory()) {
        throw new SandboxSetupError("sandbox_setup_failed", "runtime root is not a directory");
      }
      directoryMounts.push({ source: canonical, target: directory, writable: false });
    }
    directoryMounts.push({
      source: enforceSource(policy.workspaceRoot, "workspace"),
      target: policy.workspaceRoot,
      writable: policy.workspaceAccess === "read-write",
    });
    for (const temporary of [
      "/tmp",
      "/dev/shm",
      ...policy.temporaryWriteRoots,
      ...policy.additionalWriteRoots,
    ]) {
      if (!existsSync(temporary)) continue;
      const canonical = enforceSource(temporary, "temporary root");
      if (!lstatSync(canonical).isDirectory()) continue;
      directoryMounts.push({ source: canonical, target: canonical, writable: true });
    }
    const writableAt = (path: string): boolean =>
      [...directoryMounts]
        .reverse()
        .filter((mount) => nestedWithin(path, mount.target))
        .sort((left, right) => right.target.length - left.target.length)[0]?.writable ?? false;
    const args: string[] = [
      "--die-with-parent",
      "--new-session",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--cap-drop",
      "ALL",
      "--ro-bind",
      "/",
      "/",
    ];
    if (policy.network === "disabled") args.push("--unshare-net");
    args.push("--dev", "/dev", "--proc", "/proc");
    if (existsSync("/sys")) args.push("--tmpfs", "/sys", "--remount-ro", "/sys");
    for (const mount of directoryMounts.sort(
      (left, right) => left.target.length - right.target.length,
    )) {
      args.push(mount.writable ? "--bind" : "--ro-bind", mount.source, mount.target);
    }
    for (const requested of policy.readOnlyPaths) {
      if (!existsSync(requested)) {
        if (!writableAt(requested)) continue;
        args.push("--tmpfs", requested, "--remount-ro", requested);
        continue;
      }
      const canonical = realpathSync(requested);
      for (const path of new Set([requested, canonical])) {
        args.push("--ro-bind", canonical, path);
      }
    }
    for (const requested of policy.denies) {
      if (!existsSync(requested)) {
        if (
          writableAt(requested) &&
          !policy.readOnlyPaths.some((root) => nestedWithin(requested, root))
        ) {
          throw new SandboxSetupError(
            "sandbox_setup_failed",
            "A missing deny target lies inside a writable sandbox root",
          );
        }
        continue;
      }
      const deny = realpathSync(requested);
      args.push(
        lstatSync(deny).isDirectory() ? "--tmpfs" : "--ro-bind",
        lstatSync(deny).isDirectory() ? deny : assets.denyFile,
      );
      if (!lstatSync(deny).isDirectory()) args.push(deny);
      else args.push("--remount-ro", deny);
    }
    args.push("--remount-ro", "/");
    args.push("--chdir", resolve(child.cwd), "--", child.file, ...child.args);
    const helperStat = statSync(bwrap);
    const launcherStat = statSync(assets.launcher);
    const boundaryKey = [
      bwrap,
      helperStat.dev,
      helperStat.ino,
      helperStat.size,
      helperStat.mtimeMs,
      launcherStat.ino,
      launcherStat.size,
      launcherStat.mtimeMs,
      policy.network,
    ].join(":");
    if (!this.provenBoundaries.has(boundaryKey)) {
      probeBoundary(assets.launcher, bwrap, policy.network);
      this.provenBoundaries.add(boundaryKey);
    }
    return {
      file: assets.launcher,
      args: [
        policy.network === "disabled" ? "--network-disabled" : "--network-enabled",
        bwrap,
        ...args,
      ],
      cwd: child.cwd,
      env: child.env,
      backend: this.name,
      policyId: policy.id,
    };
  }
}
