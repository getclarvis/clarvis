import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PluginManifest } from "@clarvis/loop/host";

/** Resource bounds for package-local files that can enter a plugin process. */
export const PLUGIN_EXECUTABLE_RESOURCE_LIMITS = Object.freeze({
  files: 256,
  fileBytes: 8 * 1024 * 1024,
  aggregateBytes: 32 * 1024 * 1024,
});

/** Immutable identity of one package-local file referenced by an executable declaration. */
export interface PluginExecutableFileSnapshot {
  path: string;
  digest: string;
  bytes: number;
  mode: number;
}

/** Result of resolving and hashing the package-local executable surface. */
export type PluginExecutableSnapshotResult =
  { ok: true; files: PluginExecutableFileSnapshot[] } | { ok: false; error: string };

/** Normalize a platform path for a canonical cross-host digest record. */
function canonicalPath(path: string): string {
  return path.split(sep).join("/");
}

/** Resolve an existing regular file only when its real target remains inside the package root. */
function confinedFile(root: string, candidate: string): string | undefined {
  try {
    const target = realpathSync(candidate);
    const comparableRoot = process.platform === "win32" ? root.toLowerCase() : root;
    const comparableTarget = process.platform === "win32" ? target.toLowerCase() : target;
    if (comparableTarget !== comparableRoot && !comparableTarget.startsWith(comparableRoot + sep)) {
      return undefined;
    }
    return statSync(target).isFile() ? target : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve an existing directory only when its real target remains inside the package root. */
function confinedDirectory(root: string, candidate: string): string | undefined {
  try {
    const target = realpathSync(candidate);
    const comparableRoot = process.platform === "win32" ? root.toLowerCase() : root;
    const comparableTarget = process.platform === "win32" ? target.toLowerCase() : target;
    if (comparableTarget !== comparableRoot && !comparableTarget.startsWith(comparableRoot + sep)) {
      return undefined;
    }
    return statSync(target).isDirectory() ? target : undefined;
  } catch {
    return undefined;
  }
}

/** Turn one argv token into a package-local file candidate when its execution base is known. */
function argvFile(root: string, base: string | undefined, token: string): string | undefined {
  if (token.length === 0 || token.includes("\0") || token.startsWith("-")) return undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token)) return undefined;
  const candidate = isAbsolute(token)
    ? token
    : base === undefined
      ? undefined
      : resolve(base, token);
  return candidate === undefined ? undefined : confinedFile(root, candidate);
}

/** Extract shell words conservatively so absolute package paths in hook commands can be identified. */
function shellWords(command: string): string[] {
  return [...command.matchAll(/"(?:\\.|[^"])*"|'[^']*'|[^\s;&|<>]+/g)].map((match) => {
    const word = match[0];
    return word.length >= 2 &&
      ((word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'")))
      ? word.slice(1, -1)
      : word;
  });
}

/** Hash one regular file through the same descriptor that supplied its size and mode. */
function hashFile(path: string): PluginExecutableFileSnapshot | { error: string } {
  let fd: number;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
  } catch (error) {
    return {
      error: `package executable '${path}' could not be opened: ${(error as Error).message}`,
    };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { error: `package executable '${path}' is not a regular file` };
    if (stat.size > PLUGIN_EXECUTABLE_RESOURCE_LIMITS.fileBytes) {
      return {
        error:
          `package executable '${path}' exceeds the ` +
          `${String(PLUGIN_EXECUTABLE_RESOURCE_LIMITS.fileBytes)}-byte resource limit`,
      };
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      bytes += read;
      if (bytes > PLUGIN_EXECUTABLE_RESOURCE_LIMITS.fileBytes) {
        return {
          error:
            `package executable '${path}' exceeds the ` +
            `${String(PLUGIN_EXECUTABLE_RESOURCE_LIMITS.fileBytes)}-byte resource limit`,
        };
      }
      hash.update(buffer.subarray(0, read));
    }
    return {
      path,
      digest: `sha256:${hash.digest("hex")}`,
      bytes,
      mode: stat.mode & 0o777,
    };
  } catch (error) {
    return { error: `package executable '${path}' could not be read: ${(error as Error).message}` };
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolve and hash every directly referenced package-local process file.
 *
 * @remarks Capability services execute with the plugin root as cwd. Portable MCP declarations
 * resolve their cwd to the plugin root and translated hooks carry absolute package paths. Those
 * three projections cover the executable bytes a later run can launch without hashing unrelated
 * repository content or a checkout's `.git` database. A newly appearing referenced file changes
 * the returned set just as a content or mode change changes an existing record.
 */
export function snapshotPluginExecutables(
  dir: string,
  manifest: PluginManifest,
): PluginExecutableSnapshotResult {
  let root: string;
  try {
    root = realpathSync(dir);
  } catch (error) {
    return { ok: false, error: `plugin root could not be resolved: ${(error as Error).message}` };
  }
  const candidates = new Set<string>();
  const add = (base: string | undefined, token: string): void => {
    const candidate = argvFile(root, base, token);
    if (candidate !== undefined) candidates.add(candidate);
  };

  for (const server of Object.values(manifest.mcpServers ?? {})) {
    if (server.type !== "stdio" || server.command === undefined) continue;
    const base =
      server.cwd !== undefined && isAbsolute(server.cwd)
        ? confinedDirectory(root, server.cwd)
        : undefined;
    add(base, server.command);
    for (const arg of server.args ?? []) add(base, arg);
  }

  for (const declaration of Object.values(manifest.capabilityExecutables ?? {})) {
    const override = declaration.platforms?.[process.platform];
    add(root, override?.command ?? declaration.command);
    for (const arg of override?.args ?? declaration.args) add(root, arg);
  }

  for (const hook of manifest.hooks ?? []) {
    if (hook.type === "mcp_tool") continue;
    const command =
      process.platform === "win32" ? (hook.command_windows ?? hook.command) : hook.command;
    for (const word of shellWords(command)) {
      if (isAbsolute(word)) add(undefined, word);
    }
  }

  const paths = [...candidates].sort((left, right) => left.localeCompare(right));
  if (paths.length > PLUGIN_EXECUTABLE_RESOURCE_LIMITS.files) {
    return {
      ok: false,
      error:
        `package executable surface exceeds the ` +
        `${String(PLUGIN_EXECUTABLE_RESOURCE_LIMITS.files)}-file resource limit`,
    };
  }
  const files: PluginExecutableFileSnapshot[] = [];
  let aggregateBytes = 0;
  for (const path of paths) {
    const hashed = hashFile(path);
    if ("error" in hashed) return { ok: false, error: hashed.error };
    aggregateBytes += hashed.bytes;
    if (aggregateBytes > PLUGIN_EXECUTABLE_RESOURCE_LIMITS.aggregateBytes) {
      return {
        ok: false,
        error:
          `package executable surface exceeds the ` +
          `${String(PLUGIN_EXECUTABLE_RESOURCE_LIMITS.aggregateBytes)}-byte aggregate limit`,
      };
    }
    files.push({ ...hashed, path: canonicalPath(relative(root, hashed.path)) });
  }
  return { ok: true, files };
}
