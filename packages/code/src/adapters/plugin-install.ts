import { errorText } from "./errors.ts";
import { resolveCommand, withoutGitRepositoryEnvironment } from "@clarvis/kernel/local";
import { diagnosticEvent } from "../core/diagnostic-events.ts";

const GIT_TIMEOUT_MS = 120_000;
/** How much of git's own output travels with a failure record. */
const STDERR_TAIL_CHARS = 400;

function gitEnv(): Record<string, string | undefined> {
  return {
    ...withoutGitRepositoryEnvironment(process.env),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function gitError(args: string[], out: string, code: number | null): Error {
  const why = out.trim().split("\n").slice(-2).join(" ");
  return new Error(`git ${args[0]} failed: ${why || `exit ${String(code)}`}`);
}

/**
 * Record a failed `git` invocation with the facts its message throws away.
 *
 * @param phase - `spawn` when git could not be started at all, `exit` when it
 *   ran and refused.
 * @param argv0 - the resolved git executable, so a shadowed or wrapped git on
 *   `PATH` is visible rather than inferred.
 * @param subcommand - the git verb, e.g. `clone`.
 * @param exitCode - git's exit status, or `null` when it never produced one.
 * @param output - git's captured output; only its tail is kept.
 * @remarks The thrown message is good prose and reaches the user, but the argv,
 *   the exit code and everything above the last two lines of stderr never leave
 *   it. The field is `stderr_tail` rather than `stderr` on purpose: a field
 *   named exactly `stderr` is withheld by the diagnostic sink's content
 *   classifier and would arrive as `[redacted]`.
 */
function reportGitFailure(
  phase: "spawn" | "exit",
  argv0: string,
  subcommand: string,
  exitCode: number | null,
  output: string,
): void {
  diagnosticEvent(
    "plugin.install.failed",
    {
      phase,
      argv0,
      subcommand,
      exit_code: exitCode,
      stderr_tail: output.trim().slice(-STDERR_TAIL_CHARS),
    },
    "error",
  );
}

/**
 * A source naming a place on this filesystem rather than a repository to clone.
 *
 * @remarks A marketplace may list a plugin that lives beside it on disk. Reading
 *   that listing is supported; installing from it is not, and saying so plainly
 *   is better than letting it fall through to the generic refusal.
 */
const LOCAL_PATH_RE = /^(?:[.~]{1,2}[/\\]|\/|[A-Za-z]:[/\\])/;

/**
 * Validate a plugin-marketplace git URL before it is ever passed to `git clone`.
 *
 * @param raw - the user-supplied URL.
 * @returns the trimmed URL, unchanged, once accepted.
 * @throws {@link Error} if the URL is empty, could be parsed as a command-line
 *   flag, uses git's `ext::` (arbitrary-command) transport, uses unauthenticated
 *   `http://`/`git://`, names a local filesystem path, or otherwise fails to
 *   match `https://`, `ssh://` (`user@host:path`), or `file://`.
 */
export function validateGitUrl(raw: string): string {
  const url = raw.trim();
  if (url.length === 0) throw new Error("a git URL is required");
  if (url.startsWith("-")) {
    throw new Error(`refusing '${url}': a URL starting with '-' would be read by git as a flag`);
  }
  if (/ext::/i.test(url)) {
    throw new Error(`refusing '${url}': git's ext:: transport runs an arbitrary command`);
  }
  if (LOCAL_PATH_RE.test(url)) {
    throw new Error(
      `refusing '${url}': that names a local path, and Clarvis installs a plugin from git. ` +
        `Use https://, ssh (user@host:path), or file:// for a local checkout.`,
    );
  }
  if (/^(?:http|git):\/\//i.test(url)) {
    throw new Error(
      `refusing '${url}': ${url.slice(0, url.indexOf(":"))}:// is unauthenticated cleartext, so ` +
        `anyone on the path can swap the code you are about to install. Use https:// or ssh.`,
    );
  }
  const ssh = /^(?:ssh:\/\/)?[A-Za-z0-9._-]+@[A-Za-z0-9._-]+[:/][A-Za-z0-9._~/-]+$/;
  if (/^(?:https|file):\/\//i.test(url) || ssh.test(url)) return url;
  throw new Error(
    `refusing '${url}': install from https://, ssh (user@host:path), or file:// for a local checkout`,
  );
}

/**
 * Run `git` with the given arguments, killing it after {@link GIT_TIMEOUT_MS}.
 *
 * @throws {@link Error} if `git` cannot be spawned, or exits non-zero (the
 *   message is built from its captured stderr/stdout tail).
 */
async function gitAsync(args: string[]): Promise<void> {
  const subcommand = args[0] ?? "";
  const argv0 = resolveCommand("git");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([argv0, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: gitEnv(),
    });
  } catch (e) {
    reportGitFailure("spawn", argv0, subcommand, null, errorText(e));
    throw new Error(`git could not be run: ${errorText(e)}`, { cause: e });
  }
  const killer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
  try {
    const code = await proc.exited;
    if (code === 0) return;
    const read = (s: ReadableStream<Uint8Array> | number | undefined): Promise<string> =>
      s instanceof ReadableStream ? Bun.readableStreamToText(s) : Promise.resolve("");
    const output = `${await read(proc.stderr)}${await read(proc.stdout)}`;
    reportGitFailure("exit", argv0, subcommand, code, output);
    throw gitError(args, output, code);
  } finally {
    clearTimeout(killer);
  }
}

/** Shallow-clone `url` into `into` (`--depth 1`, no submodules), via {@link gitAsync}. */
export async function gitCloneAsync(url: string, into: string): Promise<void> {
  await gitAsync(["clone", "--depth", "1", "--no-recurse-submodules", "--quiet", "--", url, into]);
}
