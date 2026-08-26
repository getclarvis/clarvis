/**
 * Executes workspace hooks: the event-triggered shell commands an operator
 * declares in `settings.json` or a plugin manifest.
 *
 * @remarks
 * This package owns matching, spawning, bounding and parsing. It does not know
 * what a lifecycle hook is - `@clarvis/loop` adapts {@link HookOutcome} to its
 * own verdict type - which is what keeps the graph acyclic: the loop depends on
 * this package, so this package must never depend on the loop.
 */
export { createHookRunner, HOOK_PROTOCOL_VERSION, MAX_STDIN_BYTES } from "./runner.ts";
export type { HookRunner, HookRunnerDeps } from "./runner.ts";

export { filterHookEnv, interpolatedNames } from "./env.ts";
export type { EnvFilterOptions, FilteredHookEnv } from "./env.ts";

export {
  argText,
  compileMatch,
  globToRegExp,
  matchesCandidate,
  ARG_MATCH_MAX_CHARS,
} from "./match.ts";
export type { CompiledMatch } from "./match.ts";

export { parseHookStdout, HOOK_MESSAGE_MAX_CHARS } from "./parse.ts";
export type { ParsedHookOutput, ParseOptions } from "./parse.ts";

export {
  runHookCommand,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
} from "./subprocess.ts";
export type {
  HookChildProcess,
  HookReadable,
  HookSpawnOptions,
  HookWritable,
  SpawnFn,
  SubprocessDeps,
  SubprocessRequest,
  SubprocessResult,
  TimerDeps,
} from "./subprocess.ts";

export { NOOP_HOOK_LOGGER } from "./types.ts";
export type {
  HookFailure,
  HookFailureKind,
  HookInvocation,
  HookLogger,
  HookMatch,
  HookOutcome,
  HookResult,
  HookSpec,
  ToolCandidate,
} from "./types.ts";
