/**
 * The workflow artifact: a named, versionable, reviewable workflow on disk.
 *
 * @remarks The shape mirrors `SKILL.md` exactly — `<root>/<name>/WORKFLOW.md`,
 * YAML frontmatter validated by zod plus a Markdown body — because a workflow is
 * the same kind of thing a skill is: authored configuration a workspace keeps in
 * its history beside `agents/` and `skills/`.
 *
 * One divergence from `@clarvis/skills` is deliberate. There, a `name` that does
 * not match its directory only warns; here it is a hard load error. A skill is
 * discovered by browsing, but a workflow is *dispatched by name*, so a document
 * whose name disagrees with its location is an ambiguity a user would only find
 * out about when the wrong thing ran.
 *
 * There is no expression language here and there will not be one: `over`,
 * `accept` and `when` are the fixed shapes {@link parseSelector} and
 * {@link parseAcceptRule} accept, and briefs interpolate flat fields only.
 */
import { closeSync, fstatSync, opendirSync, openSync, readSync, type Dirent } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseTaskTitle, TASK_TITLE_MAX } from "@clarvis/capability";
import { placeholders } from "./interpolate.ts";
import { WORKFLOW_LIMITS } from "./limits.ts";
import {
  parseAcceptRule,
  parseSelector,
  type AcceptRule,
  type RepeatSpec,
  type RoundType,
  type Selector,
} from "./rounds.ts";

/** The document a workflow directory must contain. */
export const WORKFLOW_FILE = "WORKFLOW.md";

const ROUND_TYPES = ["discovery", "findings", "verdict", "free"] as const;

const identifierSchema = z.string().trim().min(1).max(WORKFLOW_LIMITS.identifierChars);
const pathSchema = z.string().trim().min(1).max(WORKFLOW_LIMITS.pathChars);
const textSchema = z.string().trim().min(1).max(WORKFLOW_LIMITS.textChars);

const titleSchema = z
  .string()
  // `parseTaskTitle` counts code points. This cheap code-unit guard prevents an
  // adversarial multi-megabyte title from being spread just to reject it.
  .max(TASK_TITLE_MAX * 2)
  .transform((value, ctx) => {
    const parsed = parseTaskTitle(value);
    if (parsed.ok) return parsed.title;
    ctx.addIssue({ code: "custom", message: parsed.message });
    return z.NEVER;
  });

const roundSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(WORKFLOW_LIMITS.identifierChars)
    .regex(/^[A-Za-z0-9._-]+$/u, "a round id must not contain whitespace or separators"),
  type: z.enum(ROUND_TYPES),
  profile: identifierSchema.optional(),
  over: pathSchema,
  title: titleSchema,
  brief: pathSchema,
  fanout: z.number().int().positive().max(WORKFLOW_LIMITS.fanout).optional(),
  accept: pathSchema.optional(),
  when: pathSchema.optional(),
});

const repeatSchema = z.object({
  rounds: z.array(identifierSchema).min(1).max(WORKFLOW_LIMITS.repeatRounds),
  until: z.enum(["no_new", "budget"]).default("no_new"),
  dedupe_by: z.array(identifierSchema).min(1).max(WORKFLOW_LIMITS.repeatDedupeFields),
  dry_rounds: z.number().int().positive().max(WORKFLOW_LIMITS.repeatDryRounds).optional(),
  max_rounds: z.number().int().positive().max(WORKFLOW_LIMITS.repeatMaxRounds),
});

/** The frontmatter contract of a `WORKFLOW.md`. */
export const workflowFrontmatterSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "name is required")
      .max(WORKFLOW_LIMITS.identifierChars)
      .regex(/^[A-Za-z0-9._-]+$/u, "name must not contain path separators or whitespace"),
    description: textSchema,
    args: z.array(identifierSchema).max(WORKFLOW_LIMITS.args).optional(),
    rounds: z
      .array(roundSchema)
      .min(1, "a workflow needs at least one round")
      .max(WORKFLOW_LIMITS.rounds),
    repeat: repeatSchema.optional(),
  })
  .loose();

/** One round of a loaded workflow, with its selector and brief already resolved. */
export interface WorkflowRound {
  id: string;
  type: RoundType;
  profile?: string;
  over: Selector;
  /** Short title template rendered for each leader in this round. */
  title: string;
  /** The brief template, read from the `briefs/` file the document named. */
  brief: string;
  fanout: number;
  accept?: AcceptRule;
  when?: string;
}

/** A loaded, validated workflow. */
export interface WorkflowDefinition {
  name: string;
  description: string;
  args: readonly string[];
  rounds: readonly WorkflowRound[];
  repeat?: RepeatSpec;
  /** The Markdown body: the synthesis brief handed back at the end. */
  synthesis: string;
  /** Where it was loaded from, for diagnostics. */
  dir: string;
}

/** A workflow that could not be loaded, and why. */
export interface WorkflowLoadError {
  dir: string;
  message: string;
}

/** The outcome of scanning one or more roots. */
export interface WorkflowRegistry {
  workflows: readonly WorkflowDefinition[];
  errors: readonly WorkflowLoadError[];
}

interface WorkflowCatalogBudget {
  entries: number;
  workflowDirs: number;
  sourceBytes: number;
}

class WorkflowCatalogLimitError extends Error {
  constructor(message: string) {
    super(`workflow catalogue resource limit: ${message}`);
    this.name = "WorkflowCatalogLimitError";
  }
}

class WorkflowFileLimitError extends Error {
  constructor(label: string, limit: number) {
    super(`${label} exceeds the ${String(limit)} byte limit`);
    this.name = "WorkflowFileLimitError";
  }
}

function chargeCatalogSource(budget: WorkflowCatalogBudget | undefined, bytes: number): void {
  if (budget === undefined) return;
  if (budget.sourceBytes + bytes > WORKFLOW_LIMITS.catalogSourceBytes) {
    throw new WorkflowCatalogLimitError(
      `source exceeds ${String(WORKFLOW_LIMITS.catalogSourceBytes)} aggregate bytes`,
    );
  }
  budget.sourceBytes += bytes;
}

/** Read one fixed inode, stopping after one byte beyond its hard ceiling. */
function readBoundedWorkflowFile(
  path: string,
  label: string,
  maxBytes: number,
  catalogBudget?: WorkflowCatalogBudget,
): string {
  const descriptor = openSync(path, "r");
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new Error(`${label} is not a regular file`);
    if (info.size > maxBytes) throw new WorkflowFileLimitError(label, maxBytes);
    chargeCatalogSource(catalogBudget, info.size);

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(descriptor, buffer, total, buffer.length - total, null);
      if (count === 0) break;
      total += count;
    }
    if (total > maxBytes) throw new WorkflowFileLimitError(label, maxBytes);
    if (total > info.size) chargeCatalogSource(catalogBudget, total - info.size);
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u;

/** Split a document into its YAML frontmatter and its Markdown body. */
function splitFrontmatter(raw: string): { data: unknown; body: string } {
  const text = raw.replace(/^\uFEFF/u, "").trimStart();
  const match = FRONTMATTER.exec(text);
  if (match === null) {
    throw new Error("missing or misaligned YAML frontmatter (expected a leading '---' fence)");
  }
  return { data: parseYaml(match[1]!) as unknown, body: (match[2] ?? "").trim() };
}

/**
 * Read a brief template relative to the workflow directory.
 *
 * @remarks Containment is decided by {@link relative}, not by string shape: a
 *   `startsWith("/")` test misses `C:\\…` and `\\\\host\\share\\…`, both of which
 *   {@link join} would happily resolve to an absolute target on Windows.
 */
function readBrief(
  dir: string,
  rel: string,
  roundId: string,
  catalogBudget?: WorkflowCatalogBudget,
): string {
  const target = join(dir, rel);
  const inside = relative(dir, target);
  if (isAbsolute(rel) || inside.length === 0 || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`round '${roundId}': brief '${rel}' must be a path inside the workflow`);
  }
  let brief: string;
  try {
    brief = readBoundedWorkflowFile(
      target,
      `round '${roundId}': brief '${rel}'`,
      WORKFLOW_LIMITS.briefBytes,
      catalogBudget,
    ).trim();
  } catch (error) {
    if (error instanceof WorkflowFileLimitError || error instanceof WorkflowCatalogLimitError) {
      throw error;
    }
    throw new Error(`round '${roundId}': brief '${rel}' could not be read`, { cause: error });
  }
  if (brief.length > WORKFLOW_LIMITS.textChars) {
    throw new Error(
      `round '${roundId}': brief '${rel}' exceeds the ${String(WORKFLOW_LIMITS.textChars)} character limit`,
    );
  }
  return brief;
}

/**
 * Load one workflow directory.
 *
 * @param dir - the directory holding `WORKFLOW.md`.
 * @returns the validated definition.
 * @throws Error naming the field or file at fault.
 */
function loadWorkflowWithBudget(
  dir: string,
  catalogBudget?: WorkflowCatalogBudget,
): WorkflowDefinition {
  const documentPath = join(dir, WORKFLOW_FILE);
  const raw = readBoundedWorkflowFile(
    documentPath,
    WORKFLOW_FILE,
    WORKFLOW_LIMITS.artifactBytes,
    catalogBudget,
  );
  const { data, body } = splitFrontmatter(raw);
  if (body.length > WORKFLOW_LIMITS.textChars) {
    throw new Error(
      `workflow synthesis exceeds the ${String(WORKFLOW_LIMITS.textChars)} character limit`,
    );
  }
  const parsed = workflowFrontmatterSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const at = issue.path.join(".");
    throw new Error(at.length === 0 ? issue.message : `${at}: ${issue.message}`);
  }
  const front = parsed.data;
  const dirName = dir.split(/[\\/]/u).filter(Boolean).at(-1);
  if (front.name !== dirName) {
    throw new Error(
      `name '${front.name}' does not match its directory '${dirName ?? ""}'; a workflow is ` +
        "dispatched by name, so the two must agree",
    );
  }

  const ids = new Set<string>();
  const args = front.args ?? [];
  const rounds = front.rounds.map((round): WorkflowRound => {
    if (ids.has(round.id)) throw new Error(`two rounds share the id '${round.id}'`);
    ids.add(round.id);
    const over = parseSelector(round.over);
    if (over === null) throw new Error(`round '${round.id}': '${round.over}' is not a selector`);
    let accept: AcceptRule | undefined;
    if (round.accept !== undefined) {
      const rule = parseAcceptRule(round.accept);
      if (rule === null) {
        throw new Error(`round '${round.id}': '${round.accept}' is not an accept rule`);
      }
      accept = rule;
    }
    const brief = readBrief(dir, round.brief, round.id, catalogBudget);
    for (const reference of placeholders(brief)) {
      const [root, key] = reference.split(".");
      if (root === "args" && (key === undefined || !args.includes(key))) {
        throw new Error(
          `round '${round.id}': brief references {{${reference}}}, which is not a declared arg`,
        );
      }
    }
    return {
      id: round.id,
      type: round.type,
      over,
      title: round.title,
      brief,
      fanout: round.fanout ?? 1,
      ...(round.profile === undefined ? {} : { profile: round.profile }),
      ...(accept === undefined ? {} : { accept }),
      ...(round.when === undefined ? {} : { when: round.when }),
    };
  });

  const first = rounds[0]!;
  if (first.over.kind !== "once") {
    throw new Error(
      `round '${first.id}' runs first and must be 'once': there is no earlier round to consume`,
    );
  }
  if (front.repeat !== undefined) {
    const unknown = front.repeat.rounds.find((id) => !ids.has(id));
    if (unknown !== undefined) throw new Error(`repeat names unknown round '${unknown}'`);
  }

  return {
    name: front.name,
    description: front.description,
    args,
    rounds,
    ...(front.repeat === undefined ? {} : { repeat: front.repeat }),
    synthesis: body,
    dir,
  };
}

/** Load one workflow without sharing a catalogue-wide resource budget. */
export function loadWorkflow(dir: string): WorkflowDefinition {
  return loadWorkflowWithBudget(dir);
}

/**
 * List a bounded set of immediate subdirectories, sorted for determinism.
 *
 * @param root - the catalogue root to scan.
 * @param budget - the scan-wide resource budget.
 * @param errors - collects a root this process could not read.
 * @returns the subdirectory names, or none.
 * @remarks An unreadable root is reported rather than swallowed. It used to
 *   return no workflows and no diagnostic, which then made
 *   `buildRunWorkflowTool` return `null` and `run_workflow` **vanish from the
 *   tool list** with nothing anywhere saying why. This is a pure filesystem
 *   loader with no run context, so it takes no logger: the caller's existing
 *   `errors[]` is the channel, and the kernel already logs every entry of it.
 *   A *missing* root is still silent — that is the ordinary case when an
 *   operator has authored no workflow overrides in that scope.
 *
 *   Bun 1.4 records a bare `catch` token as an uncovered line even when its
 *   body runs, so both guards keep their handler on the guarded line.
 */
function subdirectories(
  root: string,
  budget: WorkflowCatalogBudget,
  errors: WorkflowLoadError[],
): string[] {
  let handle: ReturnType<typeof opendirSync>;
  // prettier-ignore
  try { handle = opendirSync(root); } catch (err) { return unreadableRoot(root, err, errors); }

  const names: string[] = [];
  try {
    for (;;) {
      let entry: Dirent | null;
      // prettier-ignore
      try { entry = handle.readSync(); } catch (err) { return unreadableRoot(root, err, errors); }
      if (entry === null) break;
      budget.entries += 1;
      if (budget.entries > WORKFLOW_LIMITS.catalogEntries) {
        throw new WorkflowCatalogLimitError(
          `scan exceeds ${String(WORKFLOW_LIMITS.catalogEntries)} directory entries`,
        );
      }
      if (!entry.isDirectory()) continue;
      budget.workflowDirs += 1;
      if (budget.workflowDirs > WORKFLOW_LIMITS.catalogWorkflows) {
        throw new WorkflowCatalogLimitError(
          `scan exceeds ${String(WORKFLOW_LIMITS.catalogWorkflows)} workflow directories`,
        );
      }
      names.push(entry.name);
    }
  } finally {
    try {
      handle.closeSync();
    } catch {
      // A root removed during discovery is equivalent to an empty root.
    }
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * Record a root the process could not read, and contribute no workflows from it.
 *
 * @param root - the catalogue root.
 * @param err - what the filesystem raised.
 * @param errors - the registry's diagnostic list.
 * @returns the empty name list, so a caller can `return` this directly.
 * @remarks `ENOENT` is not an error: a workspace that has authored no workflows
 *   has no `workflows/` directory, and reporting that on every run would make
 *   the diagnostic list worthless. Everything else — a permission denial, a
 *   root that is a file, an I/O fault — is a real absence the operator has to
 *   be told about, because its only other symptom is `run_workflow` quietly
 *   not being offered.
 */
function unreadableRoot(root: string, err: unknown, errors: WorkflowLoadError[]): string[] {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code !== "ENOENT") {
    errors.push({
      dir: root,
      message: `workflow root is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return [];
}

/**
 * Scan roots for workflow definitions.
 *
 * @param roots - in ascending precedence, so a workspace root overrides a global
 *   one of the same name — the direction `@clarvis/skills` already establishes.
 * @returns the workflows by name plus every directory that failed to load.
 * @remarks A load failure is collected, never thrown: one malformed workflow must
 *   not make every other one undiscoverable.
 */
export function loadWorkflows(roots: readonly string[]): WorkflowRegistry {
  if (roots.length > WORKFLOW_LIMITS.catalogRoots) {
    return {
      workflows: [],
      errors: [
        {
          dir: roots[WORKFLOW_LIMITS.catalogRoots] ?? "<roots>",
          message: `workflow catalogue resource limit: scan exceeds ${String(WORKFLOW_LIMITS.catalogRoots)} roots`,
        },
      ],
    };
  }

  const byName = new Map<string, WorkflowDefinition>();
  const errors: WorkflowLoadError[] = [];
  const budget: WorkflowCatalogBudget = { entries: 0, workflowDirs: 0, sourceBytes: 0 };
  let limitAt = "<roots>";
  try {
    for (const root of roots) {
      limitAt = root;
      for (const name of subdirectories(root, budget, errors)) {
        const dir = join(root, name);
        limitAt = dir;
        try {
          const workflow = loadWorkflowWithBudget(dir, budget);
          byName.set(workflow.name, workflow);
        } catch (err) {
          if (err instanceof WorkflowCatalogLimitError) throw err;
          errors.push({ dir, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  } catch (err) {
    if (!(err instanceof WorkflowCatalogLimitError)) throw err;
    return {
      workflows: [],
      errors: [{ dir: limitAt, message: err.message }],
    };
  }
  return {
    workflows: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    errors,
  };
}
