/**
 * Booting `@clarvis/code` under a real PTY and observing when text reaches the
 * screen — the mechanism shared by the smoke test and the first-paint benchmark.
 *
 * @remarks
 * The TUI refuses to start without a terminal, so every observation here goes
 * through `script(1)` (or an isolated fixture-owned tmux server in ordinary
 * environment mode where `script` is absent)
 * rather than through a pipe. Extracted from `smoke-artifact.ts` when the
 * benchmark needed the same boot but several markers and many repetitions;
 * keeping one implementation is what stops the two from disagreeing about what
 * "first paint" means.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  createSmokeFixture,
  requireNativeSmokeConfinement,
  type SmokeContext,
  type SmokeChild,
  type SmokeConfinement,
  type SmokeEnvironmentOverride,
} from "./isolation.ts";

/** The fatal-boot screen's headline; seeing it fails fast rather than at timeout. */
const FAILURE_MARKER = "failed to start";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Quote one argv member for util-linux `script -c`, which delegates to `/bin/sh`. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Strip ANSI escape sequences so a failure dump is readable in CI logs.
 *
 * @param raw - captured PTY output.
 * @returns the same text with CSI/OSC sequences removed and blank runs collapsed.
 */
export function readable(raw: string): string {
  const ESC = "\\u001B";
  const osc = new RegExp(`${ESC}\\][^]*?(?:\\u0007|${ESC}\\\\)`, "g");
  const csi = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");
  return raw
    .replace(osc, "")
    .replace(csi, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * A substring whose first appearance on screen is timed.
 *
 * @remarks `text` is sought in the raw capture *and* in its {@link readable}
 * form, because a renderable that wraps every character in its own SGR span is
 * contiguous only after the escapes are stripped.
 */
export interface BootMarker {
  /** Key this marker's timestamp is reported under. */
  name: string;
  /** The substring to look for. */
  text: string;
}

/** What one observed boot produced. */
export interface BootObservation {
  /** `ready` once every marker was seen, `failed` on {@link FAILURE_MARKER}, else `timeout`. */
  outcome: "ready" | "failed" | "timeout";
  /** Milliseconds from spawn to the last marker seen, or to giving up. */
  elapsed: number;
  /** Milliseconds from spawn to each marker's first appearance. */
  marks: Record<string, number>;
  screen: string;
  stderr: string;
}

/** Inputs for {@link bootAndObserve}. */
export interface BootOptions {
  /** Bun runtime used to execute the entry; defaults to the current process. */
  runtime?: string;
  /** Absolute path to the JavaScript or TypeScript entry Bun should run. */
  entry: string;
  /** Arguments passed after the entry, e.g. `["--debug"]`. */
  args?: string[];
  /** Complete fixture context owning HOME, global state, workspace and cleanup. */
  context: SmokeContext;
  /** Markers to time. The boot is `ready` once all of them have appeared. */
  markers: BootMarker[];
  /** Optional non-visual readiness check polled after every marker is visible. */
  afterMarkersReady?: () => boolean | Promise<boolean>;
  /** Give up after this many milliseconds. */
  timeoutMs: number;
  /** How often the screen is sampled; also the measurement's quantisation floor. */
  pollMs: number;
  /** Explicitly admitted variant/install overrides; reserved roots cannot be replaced. */
  overrides?: SmokeEnvironmentOverride;
  /** Require a real native boundary; never falls back to an unconfined PTY. */
  confinement?: SmokeConfinement;
  /** Host trees required read-only by the native boundary, such as the checkout. */
  readOnlyRoots?: string[];
}

function matched(raw: string, plain: string, text: string): boolean {
  return raw.includes(text) || plain.includes(text);
}

/**
 * Record which markers are visible, mutating `marks` for any seen for the first time.
 *
 * @returns `true` once every marker has been observed.
 */
function observe(
  screen: string,
  markers: BootMarker[],
  marks: Record<string, number>,
  at: number,
): boolean {
  const plain = readable(screen);
  for (const marker of markers) {
    if (marks[marker.name] === undefined && matched(screen, plain, marker.text)) {
      marks[marker.name] = at;
    }
  }
  return markers.every((marker) => marks[marker.name] !== undefined);
}

/** Build the platform-specific `script(1)` command that gives OpenTUI a PTY. */
function scriptCommand(runtime: string, entry: string, args: string[]): string[] | undefined {
  const script =
    Bun.which("script") ??
    ["/usr/bin/script", "/bin/script", "/usr/local/bin/script"].find((path) => existsSync(path));
  if (script === undefined) return undefined;
  if (process.platform === "darwin") {
    return [script, "-q", "/dev/null", runtime, entry, ...args];
  }
  return [script, "-qec", [runtime, entry, ...args].map(shellQuote).join(" "), "/dev/null"];
}

async function observeViaScript(
  command: string[],
  options: BootOptions,
  log: string,
): Promise<BootObservation> {
  const started = performance.now();
  const environment = options.context.environmentFor(options.overrides);
  const child = Bun.spawn(command, {
    cwd: options.context.workspace,
    env: environment,
    stdout: Bun.file(log),
    stderr: "pipe",
    stdin: "ignore",
  });
  const unregister = options.context.registerChild(child);

  const marks: Record<string, number> = {};
  let outcome: BootObservation["outcome"] = "timeout";
  try {
    while (performance.now() - started < options.timeoutMs) {
      const screen = await Bun.file(log)
        .text()
        .catch(() => "");
      const at = performance.now() - started;
      if (
        observe(screen, options.markers, marks, at) &&
        (options.afterMarkersReady === undefined || (await options.afterMarkersReady()))
      ) {
        outcome = "ready";
        break;
      }
      if (screen.includes(FAILURE_MARKER)) {
        outcome = "failed";
        break;
      }
      if (child.exitCode !== null) break;
      await sleep(options.pollMs);
    }
    const elapsed = performance.now() - started;

    child.kill("SIGKILL");
    await child.exited;
    return {
      outcome,
      elapsed,
      marks,
      screen: await Bun.file(log)
        .text()
        .catch(() => ""),
      stderr: await new Response(child.stderr).text().catch(() => ""),
    };
  } finally {
    unregister();
  }
}

async function observeViaTmux(options: BootOptions): Promise<BootObservation> {
  const tmux = Bun.which("tmux");
  if (tmux === null) {
    throw new Error("observing a boot requires either script(1) or tmux to provide a PTY");
  }
  const socket = join(options.context.sockets, `tmux-${process.pid}-${Date.now()}.sock`);
  const target = "boot";
  const environment = options.context.environmentFor(options.overrides);
  const command = [
    "exec env -i",
    ...Object.entries(environment).map(([name, value]) => `${name}=${shellQuote(value)}`),
    shellQuote(options.runtime ?? process.execPath),
    shellQuote(options.entry),
    ...(options.args ?? []).map(shellQuote),
  ].join(" ");
  const started = performance.now();
  const start = Bun.spawnSync(
    [
      tmux,
      "-S",
      socket,
      "new-session",
      "-d",
      "-s",
      target,
      "-x",
      "200",
      "-y",
      "50",
      "-c",
      options.context.workspace,
      command,
    ],
    { env: environment },
  );
  const startError = start.stderr.toString();
  if (start.exitCode !== 0) {
    throw new Error(`tmux could not start the boot PTY: ${startError}`);
  }
  const tmuxChild: SmokeChild = {
    kill: () => {
      Bun.spawnSync([tmux, "-S", socket, "kill-server"], { env: environment });
    },
    exited: Promise.resolve(0),
  };
  const unregister = options.context.registerChild(tmuxChild);

  const marks: Record<string, number> = {};
  let outcome: BootObservation["outcome"] = "timeout";
  let screen = "";
  try {
    while (performance.now() - started < options.timeoutMs) {
      const capture = Bun.spawnSync([tmux, "-S", socket, "capture-pane", "-p", "-t", target]);
      if (capture.exitCode !== 0) break;
      screen = capture.stdout.toString();
      const at = performance.now() - started;
      if (
        observe(screen, options.markers, marks, at) &&
        (options.afterMarkersReady === undefined || (await options.afterMarkersReady()))
      ) {
        outcome = "ready";
        break;
      }
      if (screen.includes(FAILURE_MARKER)) {
        outcome = "failed";
        break;
      }
      await sleep(options.pollMs);
    }
  } finally {
    Bun.spawnSync([tmux, "-S", socket, "kill-server"], { env: environment });
    unregister();
  }
  return { outcome, elapsed: performance.now() - started, marks, screen, stderr: startError };
}

/**
 * Boot the TUI under a PTY and time each marker's first appearance.
 *
 * @param options - entry, fixture directories, markers and bounds.
 * @returns the observation; the child is always killed before this resolves.
 */
export async function bootAndObserve(options: BootOptions): Promise<BootObservation> {
  let command = scriptCommand(
    options.runtime ?? process.execPath,
    options.entry,
    options.args ?? [],
  );
  if (options.confinement === "required") {
    if (command === undefined) {
      throw new Error("smoke_native_confinement_unavailable:script_pty_required");
    }
    command = await requireNativeSmokeConfinement(
      options.context,
      command,
      options.readOnlyRoots ?? [],
    );
  }
  if (command === undefined) return observeViaTmux(options);
  const log = join(options.context.logs, `clarvis-boot-${process.pid}-${Date.now()}.log`);
  return observeViaScript(command, options, log);
}

/**
 * Re-export the smoke fixture that holds credentials-shaped settings and **no
 * agent files at all**.
 *
 * @remarks Not seeding agents is the point: the fleet ships as data inside the
 *   bundle, so a home with an empty `agents/` directory is what a first run
 *   really looks like. The fixture used to copy five markdown templates in, and
 *   would therefore have gone on reporting a healthy header long after the
 *   bundle stopped carrying a fleet of its own.
 *
 *   The layout comes from `globalPaths` rather than from joined literals: the
 *   directory vocabulary moved once and a hand-seeded fixture kept writing the
 *   old shape, so the artifact booted to a fleet-less header and the failure
 *   read as a timeout rather than as "the fixture is stale".
 *
 * @returns a complete, self-owned smoke context rather than a path that callers
 *   could accidentally combine with ambient state.
 */
export {
  createSmokeFixture,
  type SmokeContext,
  type SmokeEnvironmentOverride,
} from "./isolation.ts";

/** @deprecated Use {@link createSmokeFixture}; callers now own a complete context. */
export const makeCleanHome = createSmokeFixture;
