import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { kernelError } from "../../core/errors.ts";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import { withoutGitRepositoryEnvironment } from "@clarvis/paths";
import type { ProcessRunner } from "../../ports/process-runner.ts";
import type {
  InstalledPlugin,
  PluginFetcher,
  PreparedPlugin,
} from "../../ports/plugin-repository.ts";

const GIT_TIMEOUT_MS = 120_000;

/** Options for the Git-backed plugin fetcher. */
export interface GitPluginFetcherOptions {
  /** Directory in which temporary checkouts are created. */
  globalDir: string;
  /** Asynchronous process adapter. */
  processRunner: ProcessRunner;
  /** Immutable child-process environment. */
  environment: Readonly<Record<string, string | undefined>>;
  /** Where a failed Git operation is reported. */
  logger?: Logger;
}

/**
 * The host part of a remote, with nothing that could be a credential.
 *
 * @param source - the repository the operator asked for.
 * @returns the host, `local` for a filesystem path, or `unknown`.
 * @remarks A Git remote is one of the few strings in this package that
 * routinely carries a secret: `https://user:token@host/repo` is a supported
 * form, and `@clarvis/capability`'s redaction covers key-*shaped* strings, not
 * URL userinfo. Keeping only the host is what makes this loggable at all.
 */
function repoHost(source: string): string {
  const scp = /^[^/@:]+@([^:/]+):/.exec(source);
  if (scp !== null) return scp[1] ?? "unknown";
  try {
    return new URL(source).hostname || "unknown";
  } catch {
    return isAbsolute(source) || source.startsWith(".") ? "local" : "unknown";
  }
}

/**
 * Report a Git command that failed.
 *
 * @param logger - the local component's logger.
 * @param op - the Git subcommand.
 * @param source - the remote, reduced to its host before anything is written.
 * @param error - the failure `gitFailure` built.
 */
function reportGitFailure(logger: Logger, op: string, source: string, error: unknown): void {
  logger.warn(
    {
      event: "local.git.failed",
      op,
      repo_host: repoHost(source),
      cause: error instanceof Error ? error.message : String(error),
    },
    "a Git operation failed; the plugin is neither installed nor updated and the previous checkout is untouched",
  );
}

/** Resolve an optional plugin subdirectory without allowing checkout escape. */
function pluginRoot(checkout: string, subdir: string | undefined): string {
  if (subdir === undefined || subdir === "" || subdir === ".") return checkout;
  const resolved = resolve(checkout, subdir);
  const rel = relative(checkout, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw kernelError(
      "invalid_request",
      `refusing plugin path '${subdir}': it must be a subdirectory of the repository`,
    );
  }
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw kernelError("invalid_request", `plugin path '${subdir}' is not a directory in the repo`);
  }
  return resolved;
}

/** Build a concise Git failure from captured output. */
function gitFailure(args: readonly string[], output: string, code: number | null): Error {
  const why = output.trim().split("\n").slice(-2).join(" ");
  return new Error(`git ${args[0]} failed: ${why || `exit ${String(code)}`}`);
}

/**
 * Create a cancellable Git plugin fetcher.
 *
 * @param options - staging root, process runner, and environment.
 * @returns fetch/update operations with prompt-disabled Git policy.
 */
export function createGitPluginFetcher(options: GitPluginFetcherOptions): PluginFetcher {
  const logger = options.logger ?? NOOP_LOGGER;
  const environment = {
    ...withoutGitRepositoryEnvironment(options.environment),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = async (
    args: readonly string[],
    cwd: string | undefined,
    signal: AbortSignal | undefined,
    source: string,
  ): Promise<string> => {
    const result = await options.processRunner.run({
      command: "git",
      args,
      ...(cwd !== undefined ? { cwd } : {}),
      environment,
      timeoutMs: GIT_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (result.exitCode !== 0) {
      const failure = gitFailure(args, `${result.stderr}${result.stdout}`, result.exitCode);
      reportGitFailure(logger, args[0] ?? "git", source, failure);
      throw failure;
    }
    return result.stdout.trim();
  };

  const fetch = async (
    source: string,
    subdir: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<PreparedPlugin> => {
    mkdirSync(options.globalDir, { recursive: true, mode: 0o700 });
    const staging = mkdtempSync(join(options.globalDir, ".plugin-staging-"));
    const checkout = join(staging, "repo");
    try {
      await git(
        ["clone", "--depth", "1", "--no-recurse-submodules", "--quiet", "--", source, checkout],
        undefined,
        signal,
        source,
      );
      const revision = await git(["rev-parse", "HEAD"], checkout, signal, source);
      const root = pluginRoot(checkout, subdir);
      return {
        root,
        origin: source,
        revision,
        ...(subdir !== undefined && subdir !== "" && subdir !== "." ? { subdir } : {}),
        dispose(): void {
          rmSync(staging, { recursive: true, force: true });
        },
      };
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  };

  return {
    async fetch(source, subdir, signal): Promise<PreparedPlugin> {
      return fetch(source, subdir, signal);
    },
    async update(plugin: InstalledPlugin, signal): Promise<PreparedPlugin | void> {
      if (!plugin.gitCheckout) {
        if (plugin.origin === undefined) {
          throw kernelError("invalid_request", `'${plugin.name}' was not installed from git`);
        }
        return fetch(plugin.origin, plugin.subdir, signal);
      }
      const remote = plugin.origin ?? plugin.dir;
      await git(["fetch", "--depth", "1", "--quiet", "origin", "HEAD"], plugin.dir, signal, remote);
      await git(["reset", "--hard", "--quiet", "FETCH_HEAD"], plugin.dir, signal, remote);
    },
  };
}
