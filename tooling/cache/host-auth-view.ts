import { lstat, mkdir, open, readdir, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { globalPaths } from "@clarvis/paths";

export const supportsHostAuthView = process.platform === "linux" && Bun.which("bwrap") !== null;

/** Keep renewable OAuth in its authoritative directory while masking unrelated host state in a Linux mount namespace. */
export async function prepareHostAuthView(options: {
  authenticationRoot: string;
  isolatedRoot: string;
  mountedRoot: string;
}): Promise<{ command: string[]; globalDir: string; cleanup(): Promise<void> }> {
  if (!supportsHostAuthView) throw new Error("global_oauth_view_requires_linux_bwrap");
  const authenticationRoot = await realpath(options.authenticationRoot);
  const isolatedRoot = await realpath(options.isolatedRoot);
  await mkdir(options.mountedRoot, { recursive: true });
  const mountedRoot = await realpath(options.mountedRoot);
  if (new Set([authenticationRoot, isolatedRoot, mountedRoot]).size !== 3)
    throw new Error("authentication_and_fixture_roots_must_be_distinct");
  const authName = basename(globalPaths(authenticationRoot).subscriptionsFile);
  const names = new Set([...(await readdir(authenticationRoot)), ...(await readdir(isolatedRoot))]);
  names.delete(authName);
  names.delete(`${authName}.lock`);
  const created: Array<{ path: string; directory: boolean }> = [];
  const cleanup = async () => {
    for (const entry of created.reverse()) {
      if (entry.directory) await rmdir(entry.path);
      else {
        const info = await lstat(entry.path);
        if (info.isFile() && info.size === 0) await unlink(entry.path);
        else throw new Error("host_mountpoint_changed_during_qualification");
      }
    }
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
    "--bind",
    authenticationRoot,
    mountedRoot,
  ];
  try {
    for (const name of [...names].sort()) {
      const original = join(authenticationRoot, name);
      const overlay = join(isolatedRoot, name);
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
      if (!replacement) {
        if (existing?.isDirectory()) await mkdir(overlay);
        else await writeFile(overlay, "", { flag: "wx", mode: 0o600 });
        replacement = await lstat(overlay);
      }
      if (!existing) {
        if (replacement.isDirectory()) await mkdir(original, { mode: 0o700 });
        else await (await open(original, "wx", 0o600)).close();
        created.push({ path: original, directory: replacement.isDirectory() });
      } else if (existing.isDirectory() !== replacement.isDirectory())
        throw new Error("host_auth_view_mountpoint_type_mismatch");
      command.push("--bind", overlay, join(mountedRoot, name));
    }
    return { command, globalDir: mountedRoot, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
