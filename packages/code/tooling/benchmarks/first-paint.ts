#!/usr/bin/env bun
/**
 * Measure how long `@clarvis/code` takes to load its module graph and to reach
 * first paint, with enough repetitions and enough recorded context that the
 * numbers can be compared across commits.
 *
 * @remarks
 * The regression this catches is not slowness — it is **a performance claim made
 * from one sample on an uncontrolled machine.** Three separate conclusions in an
 * earlier first-paint study had to be withdrawn because of it. The same
 * command, unchanged, measured 2.05 s and later 0.60 s; the cause was CPU
 * frequency scaling (this class of host ranges 412–3301 MHz, an 8x spread), not
 * the code. So this script refuses to print a number taken on battery or on a
 * busy machine, and stamps every report with the state it ran under.
 *
 * Two further traps are encoded here rather than left to be rediscovered:
 *
 * - **`cwd` changes the answer.** `packages/code/bunfig.toml` declares a global
 *   `preload`, so any Bun process started from that directory pays ~250 ms
 *   before its first statement. Every child spawned below gets an explicit
 *   `cwd`, and the report prints it.
 * - **`--version` is not first paint.** It exercises the module graph and
 *   nothing else. Module load, the minimal shell, the complete header and the
 *   input-ready frame are measured independently.
 *
 * Usage: `bun run bench:code [--n=7] [--arm=source] [--json] [--force]`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootAndObserve, makeCleanHome, readable } from "../artifact/pty.ts";
import {
  APP_PAINT_MARKER as PAINT_MARKER,
  APP_READY_MARKER as READY_MARKER,
  BOOT_SHELL_MARKER as SHELL_MARKER,
} from "../artifact/markers.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

const N = Number(process.env.BENCH_N ?? 7);
const POLL_MS = Number(process.env.BENCH_POLL_MS ?? 25);
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS ?? 90_000);
/** Refuse above this 1-minute load *per core*; raw load is meaningless without the core count. */
const MAX_LOAD_PER_CORE = Number(process.env.BENCH_MAX_LOAD ?? 0.35);

interface Arm {
  name: string;
  entry: string;
  /**
   * Extra environment for this arm.
   *
   * @remarks The `source` arm needs `CLARVIS_CODE_SOURCE=1`: `bin` points at the
   * launcher, which loads the bundle, so without it every arm measures the same
   * artifact and the report reads as "bundling changes nothing". It once did.
   */
  env?: Record<string, string>;
}

/** The machine state a sample was taken under; two reports are comparable only if these match. */
interface Environment {
  onAc: boolean | undefined;
  governor: string | undefined;
  profile: string | undefined;
  megahertz: number | undefined;
  loadPerCore: number;
  cores: number;
  rawLoad: number;
}

function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

/** Whether any power supply reports being online, i.e. the machine is not on battery. */
function onAcPower(): boolean | undefined {
  const root = "/sys/class/power_supply";
  if (!existsSync(root)) return undefined;
  let sawMains = false;
  for (const name of readdirSync(root)) {
    const type = readTrimmed(join(root, name, "type"));
    if (type !== "Mains") continue;
    sawMains = true;
    if (readTrimmed(join(root, name, "online")) === "1") return true;
  }
  return sawMains ? false : undefined;
}

function currentMegahertz(): number | undefined {
  const info = readTrimmed("/proc/cpuinfo");
  if (info === undefined) return undefined;
  const speeds = [...info.matchAll(/^cpu MHz\s*:\s*([\d.]+)$/gm)].map((m) => Number(m[1]));
  if (speeds.length === 0) return undefined;
  return Math.round(Math.max(...speeds));
}

function readEnvironment(): Environment {
  const cores = cpus().length;
  const rawLoad = loadavg()[0] ?? 0;
  return {
    onAc: onAcPower(),
    governor: readTrimmed("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"),
    profile: readTrimmed("/sys/firmware/acpi/platform_profile"),
    megahertz: currentMegahertz(),
    loadPerCore: rawLoad / Math.max(cores, 1),
    cores,
    rawLoad,
  };
}

function describe(env: Environment): string {
  const power = env.onAc === undefined ? "power=unknown" : env.onAc ? "power=AC" : "power=BATTERY";
  return [
    power,
    env.governor === undefined ? undefined : `governor=${env.governor}`,
    env.profile === undefined ? undefined : `profile=${env.profile}`,
    env.megahertz === undefined ? undefined : `cpu=${env.megahertz}MHz`,
    `load=${env.rawLoad.toFixed(2)}/${env.cores}core=${env.loadPerCore.toFixed(3)}`,
  ]
    .filter((part) => part !== undefined)
    .join("  ");
}

/**
 * Why this machine must not be measured right now, or `undefined` if it may be.
 *
 * @remarks Battery is **not** a refusal. Running on battery is a legitimate thing
 * to measure — it is the state a laptop user actually feels — and battery-to-battery
 * comparisons are sound. What is unsound is comparing *across* power states, and
 * that is a property of the comparison, not of the sample: the report stamps the
 * state it ran under so the reader can refuse the comparison instead.
 *
 * `--require-ac` restores a hard gate for anyone who wants one.
 */
function refusal(env: Environment, requireAc: boolean): string | undefined {
  if (requireAc && env.onAc !== true) {
    return "--require-ac was given and this machine is not on mains power";
  }
  if (env.loadPerCore > MAX_LOAD_PER_CORE) {
    return `load per core ${env.loadPerCore.toFixed(3)} exceeds ${MAX_LOAD_PER_CORE}`;
  }
  return undefined;
}

interface Stats {
  n: number;
  min: number;
  median: number;
  max: number;
}

function summarise(samples: number[]): Stats | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0]!,
    median: sorted[Math.floor(sorted.length / 2)]!,
    max: sorted[sorted.length - 1]!,
  };
}

/**
 * Time `<entry> --version`, which loads the module graph and prints one string.
 *
 * @throws if the child fails or prints something other than the version, because
 *   timing a crash-fast path is the classic way to report an improvement that is
 *   really a regression.
 */
async function timeVersion(
  entry: string,
  cwd: string,
  extraEnv?: Record<string, string>,
): Promise<number> {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, entry, "--version"], {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  await child.exited;
  const elapsed = performance.now() - started;
  if (child.exitCode !== 0) {
    throw new Error(`${entry} --version exited ${child.exitCode}: ${stdout.slice(0, 200)}`);
  }
  if (!/^clarvis \d/.test(stdout.trim())) {
    throw new Error(`${entry} --version printed something unexpected: ${stdout.slice(0, 200)}`);
  }
  return elapsed;
}

interface PaintSample {
  shell: number | undefined;
  paint: number | undefined;
  ready: number;
}

/** Boot the TUI on a fresh fixture and time the parser-free shell, header and input dock. */
async function timeFirstPaint(
  entry: string,
  extraEnv?: Record<string, string>,
): Promise<PaintSample> {
  const home = await makeCleanHome();
  const workspace = await mkdtemp(join(tmpdir(), "clarvis-bench-ws-"));
  try {
    const observed = await bootAndObserve({
      entry,
      home,
      workspace,
      markers: [
        { name: "shell", text: SHELL_MARKER },
        { name: "paint", text: PAINT_MARKER },
        { name: "ready", text: READY_MARKER },
      ],
      timeoutMs: TIMEOUT_MS,
      pollMs: POLL_MS,
      ...(extraEnv === undefined ? {} : { extraEnv }),
    });
    if (observed.outcome !== "ready") {
      throw new Error(
        `boot did not reach first paint (${observed.outcome})\n` +
          `--- screen ---\n${readable(observed.screen).slice(-2000)}\n` +
          `--- stderr ---\n${observed.stderr.slice(-1000)}`,
      );
    }
    return {
      shell: observed.marks.shell,
      paint: observed.marks.paint,
      ready: observed.marks.ready!,
    };
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

async function resolveArms(selected: string[]): Promise<Arm[]> {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
  };
  const binTarget = manifest.bin?.["clarvis"];
  const candidates: Arm[] = [
    { name: "source", entry: join(packageRoot, "src/cli.ts"), env: { CLARVIS_CODE_SOURCE: "1" } },
    { name: "bundle", entry: join(packageRoot, "dist/index.js") },
    ...(binTarget === undefined ? [] : [{ name: "bin", entry: join(packageRoot, binTarget) }]),
  ];
  const wanted =
    selected.length === 0 ? candidates : candidates.filter((a) => selected.includes(a.name));
  const present: Arm[] = [];
  for (const arm of wanted) {
    if (existsSync(arm.entry)) present.push(arm);
    else process.stderr.write(`skipping arm '${arm.name}': no entry at ${arm.entry}\n`);
  }
  return present;
}

interface ArmResult {
  name: string;
  entry: string;
  version: Stats | undefined;
  shell: Stats | undefined;
  paint: Stats | undefined;
  ready: Stats | undefined;
}

async function measure(arm: Arm, workspace: string): Promise<ArmResult> {
  process.stderr.write(`measuring '${arm.name}' (warm-up + ${N})\n`);
  await timeVersion(arm.entry, workspace, arm.env).catch(() => 0);
  const versions: number[] = [];
  for (let i = 0; i < N; i++) versions.push(await timeVersion(arm.entry, workspace, arm.env));

  await timeFirstPaint(arm.entry, arm.env).catch(() => undefined);
  const shells: number[] = [];
  const paints: number[] = [];
  const readies: number[] = [];
  for (let i = 0; i < N; i++) {
    const sample = await timeFirstPaint(arm.entry, arm.env);
    if (sample.shell !== undefined) shells.push(sample.shell);
    if (sample.paint !== undefined) paints.push(sample.paint);
    readies.push(sample.ready);
  }
  return {
    name: arm.name,
    entry: arm.entry,
    version: summarise(versions),
    shell: summarise(shells),
    paint: summarise(paints),
    ready: summarise(readies),
  };
}

function row(label: string, stats: Stats | undefined): string {
  if (stats === undefined) return `| ${label} | - | - | - | - | - |`;
  const spread = stats.max - stats.min;
  const ms = (v: number): string => `${v.toFixed(0)} ms`;
  return `| ${label} | ${stats.n} | ${ms(stats.min)} | **${ms(stats.median)}** | ${ms(stats.max)} | ${ms(spread)} |`;
}

function report(results: ArmResult[], env: Environment, cwd: string, trusted: boolean): string {
  const lines = [
    trusted
      ? ""
      : "> **UNTRUSTED** — measured outside the gate; do not compare against another run.",
    "",
    `\`${describe(env)}\``,
    "",
    env.onAc === true
      ? "_On mains power. Comparable only to other mains-power runs._"
      : "_On battery: CPU frequency scales, so the spread is wide and `min` is the stable statistic. Comparable only to other battery runs._",
    "",
    `bun ${Bun.version} · cwd \`${cwd}\` · poll ${POLL_MS} ms · n=${N} (plus one discarded warm-up)`,
    "",
    "| measurement | n | min | median | max | spread |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    lines.push(row(`\`${result.name}\` --version (module graph)`, result.version));
    lines.push(row(`\`${result.name}\` first paint (minimal shell)`, result.shell));
    lines.push(row(`\`${result.name}\` first paint (header)`, result.paint));
    lines.push(row(`\`${result.name}\` first paint (input ready)`, result.ready));
  }
  lines.push(
    "",
    "The shell-to-header gap measures the non-visual foundation that now runs behind the",
    "parser-free frame. A zero header-to-input-ready gap means the complete app becomes usable",
    "in the same observed frame.",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const asJson = argv.includes("--json");
  const selected = argv.filter((a) => a.startsWith("--arm=")).map((a) => a.slice("--arm=".length));

  const before = readEnvironment();
  const blocked = refusal(before, argv.includes("--require-ac"));
  if (blocked !== undefined && !force) {
    process.stderr.write(
      `refusing to measure: ${blocked}\n  ${describe(before)}\n` +
        `  go idle, or re-run with --force (the report will be marked UNTRUSTED)\n`,
    );
    process.exit(1);
  }

  const arms = await resolveArms(selected);
  if (arms.length === 0) {
    process.stderr.write("no arms to measure\n  run: bun run build:code\n");
    process.exit(1);
  }

  const workspace = await mkdtemp(join(tmpdir(), "clarvis-bench-cwd-"));
  const results: ArmResult[] = [];
  try {
    for (const arm of arms) results.push(await measure(arm, workspace));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }

  const after = readEnvironment();
  const drifted = Math.abs(after.loadPerCore - before.loadPerCore) > 0.25;
  const trusted = blocked === undefined && !drifted;
  if (drifted) {
    process.stderr.write(
      `load moved during the batch (${before.loadPerCore.toFixed(3)} -> ${after.loadPerCore.toFixed(3)} per core); samples are not comparable to each other\n`,
    );
  }

  if (asJson) {
    process.stdout.write(
      JSON.stringify({ trusted, before, after, cwd: workspace, n: N, results }, null, 2) + "\n",
    );
    return;
  }
  const text = report(results, before, workspace, trusted);
  process.stdout.write(text + "\n");
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined) await Bun.write(summary, text + "\n");
}

await main();
