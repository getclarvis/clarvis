import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, relative, sep } from "node:path";
import { globalPaths } from "@clarvis/paths";

export const supportsHostAuthView = process.platform === "linux" && Bun.which("bwrap") !== null;

function overlaps(left: string, right: string): boolean {
  const within = (child: string, parent: string): boolean => {
    const value = relative(parent, child);
    return value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
  };
  return within(left, right) || within(right, left);
}

async function realDirectory(path: string, label: string, create = false): Promise<string> {
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && create) return undefined;
    throw error;
  });
  if (before?.isSymbolicLink()) throw new Error(`host_auth_view_refuses_symlink_${label}`);
  if (before !== undefined && !before.isDirectory())
    throw new Error(`host_auth_view_requires_directory_${label}`);
  if (before === undefined) await mkdir(path, { recursive: true });
  const after = await lstat(path);
  if (!after.isDirectory() || after.isSymbolicLink())
    throw new Error(`host_auth_view_refuses_symlink_${label}`);
  return realpath(path);
}

/**
 * Build a Bubblewrap view that keeps only the live subscription document
 * authoritative while masking every other host-global entry with fixture state.
 *
 * @remarks The real authentication root is never used as a mountpoint staging
 * area. Files are copied into the disposable mounted root so Clarvis can use
 * atomic replacement safely. The live subscription copy is reconciled on
 * cleanup only if the host file stayed at the version observed at setup.
 */
export async function prepareHostAuthView(options: {
  authenticationRoot: string;
  isolatedRoot: string;
  mountedRoot: string;
}): Promise<{ command: string[]; globalDir: string; cleanup(): Promise<void> }> {
  if (!supportsHostAuthView) throw new Error("global_oauth_view_requires_linux_bwrap");
  const authenticationRoot = await realDirectory(options.authenticationRoot, "authentication");
  const isolatedRoot = await realDirectory(options.isolatedRoot, "isolated");
  const mountedRoot = await realDirectory(options.mountedRoot, "mounted", true);
  if (
    overlaps(authenticationRoot, isolatedRoot) ||
    overlaps(authenticationRoot, mountedRoot) ||
    overlaps(isolatedRoot, mountedRoot)
  )
    throw new Error("authentication_and_fixture_roots_must_be_distinct");
  if ((await readdir(mountedRoot)).length !== 0)
    throw new Error("host_auth_view_mount_root_must_be_empty");

  const authName = basename(globalPaths(authenticationRoot).subscriptionsFile);
  const names = new Set([...(await readdir(authenticationRoot)), ...(await readdir(isolatedRoot))]);
  const staged: string[] = [];
  let liveSubscription: { original: string; target: string; initial: string } | undefined;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    let syncError: unknown;
    try {
      if (liveSubscription !== undefined) {
        const next = await readFile(liveSubscription.target, "utf8");
        if (next !== liveSubscription.initial) {
          const current = await readFile(liveSubscription.original, "utf8");
          if (current !== liveSubscription.initial)
            throw new Error("host_auth_subscription_changed_during_qualification");
          const temporary = join(authenticationRoot, `.clarvis-auth-sync-${randomUUID()}.tmp`);
          try {
            await writeFile(temporary, next, { flag: "wx", mode: 0o600 });
            await rename(temporary, liveSubscription.original);
          } finally {
            await rm(temporary, { force: true }).catch(() => undefined);
          }
        }
      }
    } catch (error) {
      syncError = error;
    } finally {
      for (const path of staged.reverse()) await rm(path, { recursive: true, force: true });
    }
    if (syncError !== undefined) throw syncError;
  };
  const command = [
    "bwrap",
    "--bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--die-with-parent",
  ];

  try {
    for (const name of [...names].sort()) {
      const original = join(authenticationRoot, name);
      const overlay = join(isolatedRoot, name);
      const target = join(mountedRoot, name);
      const existing = await lstat(original).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      let replacement = await lstat(overlay).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing?.isSymbolicLink() || replacement?.isSymbolicLink())
        throw new Error("host_auth_view_refuses_symlink_mountpoints");

      const useLiveEntry = name === authName && existing?.isFile();
      if (!useLiveEntry && replacement === undefined) {
        if (existing?.isDirectory()) await mkdir(overlay, { mode: 0o700 });
        else await writeFile(overlay, "", { flag: "wx", mode: 0o600 });
        replacement = await lstat(overlay);
      }
      const sourceInfo = useLiveEntry ? existing : replacement;
      if (sourceInfo === undefined) continue;
      if (
        existing !== undefined &&
        !useLiveEntry &&
        existing.isDirectory() !== sourceInfo.isDirectory()
      )
        throw new Error("host_auth_view_mountpoint_type_mismatch");

      if (sourceInfo.isDirectory()) {
        await mkdir(target, { mode: 0o700 });
        staged.push(target);
        command.push("--bind", useLiveEntry ? original : overlay, target);
      } else {
        await copyFile(useLiveEntry ? original : overlay, target);
        staged.push(target);
        if (useLiveEntry) {
          liveSubscription = {
            original,
            target,
            initial: await readFile(target, "utf8"),
          };
        }
      }
    }
    return { command, globalDir: mountedRoot, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
