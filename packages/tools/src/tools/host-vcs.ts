import { spawn } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import { resolveCommand, withoutGitRepositoryEnvironment } from "@clarvis/paths";
import { ToolError } from "../errors.ts";
import { statDirectory } from "../lib/files.ts";
import { bound } from "../lib/output.ts";
import { resolvePath } from "../lib/paths.ts";
import { killTree, ownProcessGroup } from "../lib/process.ts";
import type { RuntimeConfig } from "../config.ts";
import type { ToolDef } from "./types.ts";

const GIT_EXECUTION_OPTIONS = ["--upload-pack", "--receive-pack", "--exec"];
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function isGitExecutionOption(argument: string): boolean {
  const name = argument.split("=", 1)[0] ?? argument;
  return name.length >= 3 && GIT_EXECUTION_OPTIONS.some((option) => option.startsWith(name));
}

function executableName(program: string): string {
  return basename(program)
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

function validateCommand(program: string, args: readonly string[]): void {
  if (program.includes("\0") || (!isAbsolute(program) && /[\\/]/.test(program))) {
    throw new ToolError("invalid_input", "program must be a bare command name or absolute path");
  }
  const executable = executableName(program);
  const command = args[0];
  if (executable === "git" && command === "credential") {
    throw new ToolError("denied", "git credential output is unavailable to model tools");
  }
  if (executable === "gh" && command === "auth" && args[1] === "token") {
    throw new ToolError("denied", "gh auth token output is unavailable to model tools");
  }
  if (
    executable === "git" &&
    args.slice(1).some((arg) => isGitExecutionOption(arg) || /^[A-Za-z][A-Za-z0-9+.-]*::/.test(arg))
  ) {
    throw new ToolError("denied", "git argument can execute a host program and is unavailable");
  }
}

function hostEnvironment(config: RuntimeConfig): NodeJS.ProcessEnv {
  const env = withoutGitRepositoryEnvironment(process.env);
  for (const name of config.secretEnvNames ?? []) delete env[name];
  env.GIT_CONFIG_COUNT = "2";
  env.GIT_CONFIG_KEY_0 = "core.hooksPath";
  env.GIT_CONFIG_VALUE_0 = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_CONFIG_KEY_1 = "protocol.ext.allow";
  env.GIT_CONFIG_VALUE_1 = "never";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "Never";
  env.GH_PROMPT_DISABLED = "1";
  return env;
}

function runHostCommand(
  program: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  config: RuntimeConfig,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const detached = ownProcessGroup();
    const child = spawn(resolveCommand(program), args, {
      cwd,
      env: hostEnvironment(config),
      stdio: ["ignore", "pipe", "pipe"],
      detached,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let outputLimited = false;
    let capturedBytes = 0;
    let settled = false;
    const kill = (): void => {
      if (child.pid !== undefined && killTree(child.pid, "SIGKILL", { logger: config.logger })) {
        return;
      }
      child.kill("SIGKILL");
    };
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const capture = (stream: "stdout" | "stderr", chunk: string): void => {
      if (outputLimited) return;
      capturedBytes += Buffer.byteLength(chunk, "utf8");
      if (capturedBytes > config.maxShellOutputBytes) {
        outputLimited = true;
        kill();
        return;
      }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", (chunk: string) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: string) => capture("stderr", chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new ToolError("io_error", `Failed to run ${program}: ${error.message}`));
    });
    child.once("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (aborted) {
        reject(new ToolError("aborted", `${program} command aborted`));
        return;
      }
      if (timedOut) {
        reject(
          new ToolError("timeout", `${program} command timed out after ${String(timeoutMs)}ms`),
        );
        return;
      }
      if (outputLimited) {
        reject(
          new ToolError(
            "output_limit",
            `${program} command exceeded the ${String(config.maxShellOutputBytes)} byte output limit`,
          ),
        );
        return;
      }
      resolve(
        JSON.stringify({
          exit_code: code ?? 1,
          stdout: bound(stdout, config.maxShellOutputBytes),
          stderr: bound(stderr, config.maxShellOutputBytes),
          signal: closeSignal,
        }),
      );
    });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Guard-reviewed direct execution through the host's executable environment.
 *
 * @remarks This is deliberately narrower than a host shell: it accepts one
 * executable and argv, never command text. It strips Clarvis-managed secret
 * environment variables, disables interactive prompts, and remains unavailable
 * unless the configured guard policy, judge, or human approves the exact
 * displayed invocation.
 */
export const hostVcs: ToolDef = {
  name: "host_vcs",
  description:
    "Run one executable directly on the host after guard review. Use only when the sandboxed " +
    "shell cannot perform the operation because it lacks host environment, credentials, runtime, " +
    "or service access. The configured policy, automatic judge, or human may approve it. Arguments " +
    "are passed as argv without a shell. Secret-token output and known direct Git helper options " +
    "remain unavailable.",
  inputSchema: {
    type: "object",
    properties: {
      program: { type: "string", minLength: 1, maxLength: 4096 },
      args: {
        type: "array",
        items: { type: "string", maxLength: 16_384 },
        minItems: 0,
        maxItems: 128,
      },
      cwd: {
        type: "string",
        description: "Workspace-relative directory. Default: workspace root.",
      },
      timeout_ms: { type: "integer", minimum: 1 },
    },
    required: ["program", "args"],
  },
  async handler(args, config, signal) {
    const program = args.program as string;
    const argv = args.args as string[];
    validateCommand(program, argv);
    const cwdArg = args.cwd as string | undefined;
    const cwd = cwdArg ? resolvePath(cwdArg, config.workspaceRoot, true) : config.workspaceRoot;
    await statDirectory(cwd, cwdArg ?? cwd);
    const requested = (args.timeout_ms as number | undefined) ?? config.shellTimeoutMs;
    const timeoutMs = Math.min(requested, config.shellTimeoutMaxMs, MAX_TIMER_DELAY_MS);
    return runHostCommand(program, argv, cwd, timeoutMs, config, signal);
  },
};
