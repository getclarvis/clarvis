import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { Logger } from "@clarvis/capability";
import type { SkillDiagnostics, WarnSink } from "../../src/lib/log.ts";
import { recordingLogger, type LogRecord } from "./logging.ts";
import { clarvisSkillRoots } from "../../src/preset.ts";
import { agentsSkillsDirs, globalPaths, workspacePaths } from "@clarvis/paths";
import type { SkillRootInput } from "../../src/types.ts";

export { makeInfo } from "./skill-fixtures.ts";

export function makeHome(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "clarvis-skills-home-")));
}

export function makeWorkspace(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "clarvis-skills-ws-")));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function skillsRoot(base: string, source: "agents" | "clarvis"): string {
  if (source === "agents") return agentsSkillsDirs({ env: {}, home: base, cwd: base }).user;
  return workspacePaths(base).skillsDir;
}

/** The user-scope `.clarvis` skills root, which the global layout nests differently. */
export function userSkillsRoot(home: string): string {
  return globalPaths(path.join(home, ".clarvis")).skillsDir;
}

export function clarvisRoots(home: string, ws: string): SkillRootInput[] {
  return clarvisSkillRoots({ home, workspace: ws, env: {} });
}

export interface WriteSkillOptions {
  frontmatter?: Record<string, unknown>;
  body?: string;
  raw?: string;
  resources?: Record<string, string>;
  dirName?: string;
}

export function writeSkill(root: string, name: string, opts: WriteSkillOptions = {}): string {
  const dir = path.join(root, opts.dirName ?? name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), opts.raw ?? buildSkillMd(name, opts));
  for (const [rel, body] of Object.entries(opts.resources ?? {})) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

function buildSkillMd(name: string, opts: WriteSkillOptions): string {
  const frontmatter = { name, description: `The ${name} skill`, ...(opts.frontmatter ?? {}) };
  return `---\n${stringifyYaml(frontmatter)}---\n\n${opts.body ?? `Body of ${name}.`}\n`;
}

export interface CapturedWarnings extends SkillDiagnostics {
  warnings: string[];
  warningSink: WarnSink;
  logger: Logger;
  /** Every structured record the same run emitted. */
  records: LogRecord[];
  /** Records carrying the given `event` field. */
  events(name: string): LogRecord[];
  restore(): void;
}

/**
 * Capture both diagnostic channels of one discovery run.
 *
 * @remarks The result satisfies `SkillDiagnostics`, so it is passed straight to
 * `resolveConfig`/`createAgentSkills` and to the `scan.ts` helpers.
 */
export function captureWarnings(): CapturedWarnings {
  const warnings: string[] = [];
  const recorder = recordingLogger();
  return {
    warnings,
    warningSink: (message) => warnings.push(message),
    logger: recorder.logger,
    records: recorder.records,
    events: (name) => recorder.events(name),
    restore: () => {},
  };
}
