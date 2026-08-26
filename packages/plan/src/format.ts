import { createHash, randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { PlanIndex } from "./repository.ts";
import { MAX_PLAN_TASKS, MAX_PLAN_VALIDATION_ITEMS, assertPlanSourceSize } from "./limits.ts";
import {
  DEFAULT_PLAN_RETENTION,
  planDocumentSchema,
  type PlanDocument,
  type PlanRetention,
  type PlanTask,
  type PlanTaskStatus,
} from "./schemas.ts";

const CONTROLLED = new Set([
  "id",
  "title",
  "status",
  "retention",
  "revision",
  "spec_revision",
  "created_at",
  "updated_at",
  "created_by_run",
  "approved_spec_revision",
]);
const SECTIONS = ["Objective", "Context", "Tasks", "Validation", "Notes"] as const;
const MARKERS: Record<PlanTaskStatus, string> = {
  pending: " ",
  in_progress: ">",
  returned: "<",
  done: "x",
  abandoned: "-",
  failed: "!",
};
const FROM_MARKER: Record<string, PlanTaskStatus> = Object.fromEntries(
  Object.entries(MARKERS).map(([status, marker]) => [marker, status]),
) as Record<string, PlanTaskStatus>;

/**
 * The SHA-256 hex digest of `text`. Used to fingerprint a plan's rendered bytes
 * for the compare-and-swap contract.
 *
 * @param text - the text to hash.
 * @returns the lowercase hex digest.
 */
export function digestText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The digest of a plan's *substance* — its objective, context, validation, and
 * the id/title/detail/exit of each task. Status and outcome fields are excluded,
 * so recording task progress does not change the spec digest; only editing the
 * plan's substance does.
 *
 * @remarks The membership rule is one question asked of every field: would a
 * human who approved this plan want to be asked again? Progress fields are out
 * because recording that a task was done is the plan being *followed*, not
 * changed. The plan's own `title` is out for the same reason even though
 * `set_title` can edit it — it is the document's label, and renaming a plan
 * mid-run must not invalidate an approval or a caller's outstanding
 * compare-and-swap triple. Everything that survives describes what the work
 * *is*, which is exactly what an approval was given for.
 *
 * @param document - any object carrying the substantive plan fields.
 * @returns the hex digest used as {@link PlanDocument.spec_digest}.
 */
export function specDigest(
  document: Pick<PlanDocument, "objective" | "context" | "tasks" | "validation">,
): string {
  return digestText(
    JSON.stringify({
      objective: document.objective,
      context: document.context,
      tasks: document.tasks.map(({ id, title, detail, exit }) => ({ id, title, detail, exit })),
      validation: document.validation,
    }),
  );
}

/**
 * Project a plan onto the queryable {@link PlanIndex} a repository indexes.
 *
 * @param document - the parsed plan.
 * @returns the projection; `path` falls back to the empty string when the
 *   document carries no locator (the adapter assigns one on create).
 */
export function projectPlan(document: PlanDocument): PlanIndex {
  return {
    path: document.path ?? "",
    title: document.title,
    status: document.status,
    retention: document.retention,
    revision: document.revision,
    spec_revision: document.spec_revision,
    created_at: document.created_at,
    updated_at: document.updated_at,
    created_by_run: document.created_by_run,
  };
}

/**
 * Build a Windows-safe, sortable plan filename from a timestamp and title:
 * `yyyy-MM-ddTHH-mm-ss-<slug>.md`.
 *
 * @param date - the creation time; its seconds-precision UTC value forms the
 *   sortable prefix.
 * @param title - the plan title; diacritics are stripped and it is slugified to
 *   `[a-z0-9-]`, truncated to 48 chars, falling back to `plan` when empty.
 * @returns the filename (not a path).
 */
export function planFilename(date: Date, title: string): string {
  const stamp = date.toISOString().slice(0, 19).replaceAll(":", "-");
  const slug =
    title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "plan";
  return `${stamp}-${slug}.md`;
}

function splitDocument(source: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) throw new Error("Invalid plan Markdown: YAML frontmatter is required");
  const parsed: unknown = parseYaml(match[1]!);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid plan Markdown: frontmatter must be a mapping");
  return { frontmatter: parsed as Record<string, unknown>, body: match[2]! };
}

function sections(body: string): { controlled: Map<string, string>; extra: Map<string, string> } {
  const headings = [...body.matchAll(/^## (.+?)[ \t]*$/gm)];
  const slice = (start: number, end: number): string =>
    body
      .slice(start, end)
      .replace(/^\r?\n\r?\n?/, "")
      .replace(/\s+$/, "");
  const anchors: { name: string; headingStart: number; bodyStart: number }[] = [];
  let cursor = 0;
  for (const name of SECTIONS) {
    const heading = headings.find((match) => match[1] === name && match.index >= cursor);
    if (!heading) throw new Error(`Invalid plan Markdown: missing ## ${name}`);
    anchors.push({
      name,
      headingStart: heading.index,
      bodyStart: heading.index + heading[0].length,
    });
    cursor = heading.index + heading[0].length;
  }
  const notesStart = anchors[anchors.length - 1]!.headingStart;
  const extraHeadings = headings.filter((match) => match.index > notesStart);
  const controlled = new Map<string, string>();
  for (let index = 0; index < anchors.length; index += 1) {
    const end =
      index + 1 < anchors.length
        ? anchors[index + 1]!.headingStart
        : (extraHeadings[0]?.index ?? body.length);
    controlled.set(anchors[index]!.name, slice(anchors[index]!.bodyStart, end));
  }
  const extra = new Map<string, string>();
  for (let index = 0; index < extraHeadings.length; index += 1) {
    const heading = extraHeadings[index]!;
    const start = heading.index + heading[0].length;
    const end = extraHeadings[index + 1]?.index ?? body.length;
    extra.set(heading[1]!, slice(start, end));
  }
  return { controlled, extra };
}

function parseTasks(text: string): PlanTask[] {
  const lines = text.split(/\r?\n/);
  const tasks: PlanTask[] = [];
  let current: PlanTask | undefined;
  let field: "detail" | "exit" | "assignee" | "result" | "error" | "reason" | undefined;
  for (const line of lines) {
    const task = /^- \[([ x><!-])\] \((t[1-9]\d*)\) (.+)$/.exec(line);
    if (task) {
      current = { id: task[2]!, title: task[3]!.trim(), status: FROM_MARKER[task[1]!]! };
      tasks.push(current);
      field = undefined;
      continue;
    }
    const meta = /^ {2}- (Detail|Exit|Assignee|Result|Error|Reason):(?: (.*))?$/.exec(line);
    if (meta && current) {
      field = meta[1]!.toLowerCase() as typeof field;
      current[field!] = meta[2] ?? "";
      continue;
    }
    if (current && field !== undefined) {
      const continuation = /^ {4}(.*)$/.exec(line);
      if (continuation) {
        current[field] = `${current[field] ?? ""}\n${continuation[1]!}`;
        continue;
      }
      if (line.trim() === "") {
        current[field] = `${current[field] ?? ""}\n`;
        continue;
      }
    }
    if (line.trim()) throw new Error(`Invalid plan Markdown task line: ${line}`);
  }
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length)
    throw new Error("Invalid plan Markdown: duplicate task id");
  return tasks;
}

function parseValidation(text: string): string[] {
  if (!text.trim()) return [];
  return text.split(/\r?\n/).map((line) => {
    const match = /^- (.+)$/.exec(line);
    if (!match) throw new Error(`Invalid plan Markdown validation line: ${line}`);
    return match[1]!;
  });
}

/**
 * Parse a plan's Markdown source into a {@link PlanDocument}.
 *
 * @param source - the full file contents (YAML frontmatter + `##` sections).
 * @param path - the locator to record on the document for display; omitted,
 *   the plan simply carries none.
 * @returns the parsed plan, with `digest` set to the digest of `source` and
 *   `spec_digest` computed from its substance.
 * @throws {@link Error} if the frontmatter is missing/malformed, a required
 *   section is absent, or a task/validation line is unparseable.
 *
 * @remarks
 * The parser is lenient on read but its output re-renders deterministically.
 * Unknown frontmatter keys and any `##` sections beyond the required five are
 * preserved on the document ({@link PlanDocument.unknown_frontmatter} /
 * {@link PlanDocument.extra_sections}) and round-trip through {@link renderPlan}
 * intact. A `##`-style line inside a prose section (Objective/Context/Notes) is
 * treated as body text, not a section boundary.
 */
export function parsePlan(source: string, path?: string): PlanDocument {
  assertPlanSourceSize(source);
  const { frontmatter, body } = splitDocument(source);
  const { controlled, extra } = sections(body);
  const unknown = Object.fromEntries(
    Object.entries(frontmatter).filter(([key]) => !CONTROLLED.has(key)),
  );
  const parsed = planDocumentSchema.parse({
    ...(path === undefined ? {} : { path }),
    ...frontmatter,
    objective: controlled.get("Objective")!,
    context: controlled.get("Context")!,
    tasks: parseTasks(controlled.get("Tasks")!),
    validation: parseValidation(controlled.get("Validation")!),
    notes: controlled.get("Notes")!,
    unknown_frontmatter: unknown,
    extra_sections: Object.fromEntries(extra),
    digest: digestText(source),
    spec_digest: "",
  });
  return { ...parsed, spec_digest: specDigest(parsed) };
}

/**
 * Render a {@link PlanDocument} back to its Markdown source.
 *
 * @param document - the plan to serialize.
 * @returns the full file contents (frontmatter + sections), newline-terminated.
 *
 * @remarks
 * The inverse of {@link parsePlan} and deterministic: `parsePlan(renderPlan(d))`
 * yields a document that re-renders identically. Multi-line task fields
 * (detail/result/error/…) are written as indented continuation lines so they
 * survive the round-trip; {@link PlanDocument.unknown_frontmatter} and
 * {@link PlanDocument.extra_sections} are emitted verbatim. `digest`/`spec_digest`
 * are not stored in the file, so they do not affect the rendered bytes.
 */
export function renderPlan(document: PlanDocument): string {
  const fm: Record<string, unknown> = {
    ...document.unknown_frontmatter,
    id: document.id,
    title: document.title,
    status: document.status,
    retention: document.retention,
    revision: document.revision,
    spec_revision: document.spec_revision,
    created_at: document.created_at,
    updated_at: document.updated_at,
    created_by_run: document.created_by_run,
    ...(document.approved_spec_revision === undefined
      ? {}
      : { approved_spec_revision: document.approved_spec_revision }),
  };
  const tasks = document.tasks
    .map((task) => {
      const lines = [`- [${MARKERS[task.status]}] (${task.id}) ${task.title}`];
      for (const [label, key] of [
        ["Detail", "detail"],
        ["Exit", "exit"],
        ["Assignee", "assignee"],
        ["Result", "result"],
        ["Error", "error"],
        ["Reason", "reason"],
      ] as const) {
        const value = task[key];
        if (value === undefined) continue;
        const [first = "", ...rest] = value.split("\n");
        lines.push(first === "" ? `  - ${label}:` : `  - ${label}: ${first}`);
        for (const continuation of rest) lines.push(`    ${continuation}`);
      }
      return lines.join("\n");
    })
    .join("\n");
  const controlled: Record<string, string> = {
    Objective: document.objective,
    Context: document.context,
    Tasks: tasks,
    Validation: document.validation.map((item) => `- ${item}`).join("\n"),
    Notes: document.notes,
  };
  const body = [
    ...SECTIONS.map((name) => `## ${name}\n\n${controlled[name]}`),
    ...Object.entries(document.extra_sections).map(([name, value]) => `## ${name}\n\n${value}`),
  ].join("\n\n");
  const source = `---\n${stringifyYaml(fm, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trimEnd()}\n`;
  assertPlanSourceSize(source);
  return source;
}

/**
 * Build a brand-new {@link PlanDocument} in memory from creation input, ready to
 * be rendered and written. {@link PlanStore.create} uses this; call it directly
 * only to construct a plan outside the store.
 *
 * @param input - the plan's initial content. Task `id`s default to `t1`, `t2`,
 *   … in order and statuses to `pending`; `retention` defaults to
 *   {@link DEFAULT_PLAN_RETENTION};
 *   `review: true` starts the plan in `awaiting_approval`, otherwise `active`.
 *   `now` overrides the creation timestamp (for deterministic tests).
 * @returns the new plan at `revision` 1 with `digest`/`spec_digest` populated.
 * @throws {@link z.ZodError} if any field violates {@link planDocumentSchema}
 *   (e.g. a blank or multi-line task title).
 */
export function newPlan(input: {
  title: string;
  objective: string;
  context?: string;
  tasks: Array<Omit<PlanTask, "id" | "status"> & { id?: string; status?: PlanTaskStatus }>;
  validation?: string[];
  retention?: PlanRetention;
  createdByRun: string;
  review?: boolean;
  now?: Date;
}): PlanDocument {
  if (input.tasks.length > MAX_PLAN_TASKS)
    throw new RangeError(`A plan may contain at most ${MAX_PLAN_TASKS} tasks`);
  if ((input.validation?.length ?? 0) > MAX_PLAN_VALIDATION_ITEMS)
    throw new RangeError(
      `A plan may contain at most ${MAX_PLAN_VALIDATION_ITEMS} validation items`,
    );
  const now = (input.now ?? new Date()).toISOString();
  const base = {
    id: randomUUID(),
    title: input.title,
    status: input.review ? "awaiting_approval" : "active",
    retention: input.retention ?? DEFAULT_PLAN_RETENTION,
    revision: 1,
    spec_revision: 1,
    created_at: now,
    updated_at: now,
    created_by_run: input.createdByRun,
    objective: input.objective,
    context: input.context ?? "",
    tasks: input.tasks.map((task, index) => ({
      ...task,
      id: task.id ?? `t${index + 1}`,
      status: task.status ?? "pending",
    })),
    validation: input.validation ?? [],
    notes: "",
    unknown_frontmatter: {},
    extra_sections: {},
    digest: "",
    spec_digest: "",
  };
  const parsed = planDocumentSchema.parse(base);
  return {
    ...parsed,
    digest: digestText(renderPlan(parsed)),
    spec_digest: specDigest(parsed),
  };
}
