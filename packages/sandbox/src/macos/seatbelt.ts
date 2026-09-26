import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { LaunchSpec, SandboxBackend } from "../backend.ts";
import { SandboxSetupError } from "../diagnostics.ts";
import type { ExecutionPolicy } from "../policy.ts";

function quoted(path: string): string {
  return JSON.stringify(path);
}

function existing(paths: readonly string[]): string[] {
  return [
    ...new Set(paths.filter(existsSync).flatMap((path) => [resolve(path), realpathSync(path)])),
  ];
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root === sep ? root : `${root}${sep}`);
}

function subpathGrant(path: string, exclusions: readonly string[]): string {
  if (exclusions.length === 0) return `(subpath ${quoted(path)})`;
  return `(require-all (subpath ${quoted(path)}) ${exclusions
    .flatMap((excluded) => [
      `(require-not (literal ${quoted(excluded)}))`,
      `(require-not (subpath ${quoted(excluded)}))`,
    ])
    .join(" ")})`;
}

function descendantExclusions(path: string, protectedPath: string): string[] {
  const canonical = realpathSync(path);
  if (!within(protectedPath, canonical)) return [];
  return [...new Set([protectedPath, resolve(path, relative(canonical, protectedPath))])];
}

function traversalAncestors(paths: readonly string[]): string[] {
  const ancestors = new Set<string>(["/"]);
  for (const path of paths) {
    let current = dirname(path);
    while (current !== "/") {
      ancestors.add(current);
      current = dirname(current);
    }
  }
  return [...ancestors].sort((left, right) => left.length - right.length);
}

/** Produce a Seatbelt profile with narrow grants and explicit deny precedence. */
export function seatbeltProfile(policy: ExecutionPolicy): string {
  const readSubtrees = ["/"];
  const writeSubtrees = existing([
    "/tmp",
    "/private/tmp",
    ...policy.temporaryWriteRoots,
    ...policy.additionalWriteRoots,
    ...(policy.workspaceAccess === "read-write" ? [policy.workspaceRoot] : []),
  ]);
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    '(allow file-read* file-write* (literal "/dev/null"))',
    '(allow file-read* (literal "/dev/random") (literal "/dev/urandom"))',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
  ];
  for (const path of readSubtrees) {
    lines.push(`(allow file-read* ${subpathGrant(path, ["/dev"])})`);
  }
  for (const path of writeSubtrees) {
    const exclusions: string[] = [];
    if (policy.workspaceAccess === "read-only") {
      exclusions.push(...descendantExclusions(path, policy.workspaceRoot));
    }
    lines.push(`(allow file-read* file-write* ${subpathGrant(path, exclusions)})`);
  }
  for (const ancestor of traversalAncestors([
    ...readSubtrees,
    ...writeSubtrees,
    ...policy.readOnlyPaths,
  ])) {
    lines.push(`(allow file-read-metadata (literal ${quoted(ancestor)}))`);
  }
  if (policy.network === "enabled") lines.push("(allow network*)");
  lines.push("(allow system-socket (socket-domain AF_UNIX))");
  for (const path of new Set([
    ...policy.readOnlyPaths,
    ...existing(policy.readOnlyPaths),
    ...policy.installationRoots,
    ...existing(policy.installationRoots),
  ])) {
    lines.push(`(deny file-write* (subpath ${quoted(path)}))`);
    lines.push(`(deny file-write* (literal ${quoted(path)}))`);
  }
  for (const path of new Set([...policy.denies, ...existing(policy.denies)])) {
    lines.push(`(deny file-read* file-write* (subpath ${quoted(path)}))`);
    lines.push(`(deny file-read* file-write* (literal ${quoted(path)}))`);
  }
  return lines.join("\n");
}

/** Seatbelt launch backend; it cannot claim Linux namespace capabilities. */
export class SeatbeltBackend implements SandboxBackend {
  readonly name = "seatbelt" as const;
  readonly capabilities = {
    pidNamespace: false,
    mountNamespace: false,
    ipcNamespace: false,
    networkIsolation: true,
  } as const;

  prepare(
    policy: ExecutionPolicy,
    child: {
      file: string;
      args: readonly string[];
      cwd: string;
      env: Readonly<Record<string, string>>;
    },
  ): LaunchSpec {
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
      throw new SandboxSetupError("sandbox_unavailable", "Seatbelt executable unavailable");
    }
    if (policy.mode !== "sandbox") {
      throw new SandboxSetupError("sandbox_setup_failed", "Seatbelt requires sandbox mode");
    }
    if (realpathSync("/usr/bin/sandbox-exec") !== "/usr/bin/sandbox-exec") {
      throw new SandboxSetupError("sandbox_setup_failed", "Seatbelt executable is not canonical");
    }
    return {
      file: "/usr/bin/sandbox-exec",
      args: ["-p", seatbeltProfile(policy), child.file, ...child.args],
      cwd: child.cwd,
      env: child.env,
      backend: this.name,
      policyId: policy.id,
    };
  }
}
