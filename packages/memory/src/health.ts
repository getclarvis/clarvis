/**
 * Deterministic diagnostics over the memory tree.
 *
 * No model, no network, no writes. Given the same tree and the same `now`, the
 * report is byte-identical — which is why `now` is a parameter rather than a
 * call to `Date.now()` inside, and why the report echoes it back.
 *
 * The structural checks ask the reindexer and the tree model rather than
 * reimplementing them: a second, subtly different idea of what the pyramid
 * should look like would be worse than no check at all.
 */
import { parseFrontmatter } from "./frontmatter.ts";
import type { MemoryJobReader } from "./types.ts";
import { planReindex } from "./reindex.ts";
import { sanitizeText } from "@clarvis/capability";
import { truncate } from "./text.ts";
import { MEMORY_STORAGE_LIMITS, MemoryStorageLimitError } from "./storage-limits.ts";
import { analyze, DESCRIPTION_MAX_CHARS, indexFileFor, isGeneratedPlaceholder } from "./tree.ts";
import type { MemoryDoc, MemoryTx } from "./types.ts";

/** How much a finding matters. */
export type MemoryHealthSeverity = "error" | "warning" | "info";

/**
 * Every finding this pass can produce, in report order.
 *
 * @remarks Declaration order is part of the contract: findings sort by severity
 * and then by position here, so related problems group together and the report
 * is stable across runs.
 */
export const HEALTH_CODES = [
  "missing_profile",
  "recovery_required",
  "failed_index_job",
  "missing_topic_index",
  "orphan_document",
  "stale_navigation",
  "invalid_frontmatter",
  "missing_description",
  "invalid_authority",
  "empty_document",
  "document_too_large",
  "stuck_index_job",
  "placeholder_description",
  "description_too_long",
  "stale_document",
  "unknown_frontmatter_key",
] as const;

/** One diagnostic. */
export type MemoryHealthCode = (typeof HEALTH_CODES)[number];

/** A single problem found in the tree or the queue. */
export interface MemoryHealthFinding {
  code: MemoryHealthCode;
  severity: MemoryHealthSeverity;
  /** The document or job the finding concerns; `""` when tree-wide. */
  path: string;
  /** One sanitized line stating the problem. */
  message: string;
  /** One line telling the owner what to do about it. */
  suggested_action: string;
}

/** A deterministic snapshot of memory's condition. */
export interface MemoryHealthReport {
  /** The instant the report was evaluated against. */
  generated_at: number;
  totals: {
    documents: number;
    topics: number;
    memories: number;
    pending_jobs: number;
    failed_jobs: number;
  };
  counts: Record<MemoryHealthSeverity, number>;
  /** Ordered most severe first. */
  findings: MemoryHealthFinding[];
  /** True when lower-severity findings were dropped to stay within bounds. */
  truncated: boolean;
  /** Codes not evaluated, because the state they read was not available. */
  skipped_codes: MemoryHealthCode[];
}

/** Tunable thresholds. */
export interface MemoryHealthConfig {
  /** Body size past which a document no longer fits the indexer's context well. */
  maxDocumentChars: number;
  /** Age past which a document is worth re-verifying. */
  staleDays: number;
  /** How long a job may sit claimed before it looks stuck. */
  stuckJobMinutes: number;
  /** Findings kept per code. */
  maxPerCode: number;
  /** Findings kept overall. */
  maxFindings: number;
}

/** Thresholds used when a host supplies none. */
export const DEFAULT_HEALTH_CONFIG: MemoryHealthConfig = {
  maxDocumentChars: 20_000,
  staleDays: 180,
  stuckJobMinutes: 30,
  maxPerCode: 50,
  maxFindings: 200,
};

/** Longest message or action text a finding carries. */
const TEXT_MAX = 200;

const SEVERITY: Record<MemoryHealthCode, MemoryHealthSeverity> = {
  missing_profile: "error",
  recovery_required: "error",
  failed_index_job: "error",
  missing_topic_index: "warning",
  orphan_document: "warning",
  stale_navigation: "warning",
  invalid_frontmatter: "warning",
  missing_description: "warning",
  invalid_authority: "warning",
  empty_document: "warning",
  document_too_large: "warning",
  stuck_index_job: "warning",
  placeholder_description: "info",
  description_too_long: "info",
  stale_document: "info",
  unknown_frontmatter_key: "info",
};

const SEVERITY_RANK: Record<MemoryHealthSeverity, number> = { error: 0, warning: 1, info: 2 };

const TREE_HEALTH_CODES = HEALTH_CODES.filter(
  (code) =>
    code !== "recovery_required" && code !== "failed_index_job" && code !== "stuck_index_job",
);

/** Known frontmatter keys; anything else is reported rather than silently kept. */
const KNOWN_KEYS = new Set(["description", "tags", "authority", "pinned"]);

/** What {@link health} may read. Read-only by construction. */
export interface HealthArgs {
  /**
   * The tree's read surface.
   *
   * @remarks Typed as a `Pick` so it is impossible for this pass to write —
   * the same trick the reindex planner uses.
   */
  tx: Pick<MemoryTx, "list" | "read" | "readBounded">;
  /** The instant to evaluate against. */
  now: number;
  config?: Partial<MemoryHealthConfig>;
  /** The durable queue. Omit and the job codes are reported as skipped. */
  jobs?: MemoryJobReader;
  /** Whether the store is frozen awaiting an operator decision. */
  recoveryRequired?: boolean;
}

/**
 * Inspect the tree and the queue.
 *
 * @param args - see {@link HealthArgs}.
 * @returns a deterministic {@link MemoryHealthReport}.
 * @remarks Never writes. Findings are deduplicated, sorted into a total order,
 * capped per code during collection and capped overall **after** sorting — so
 * an overflowing tree loses its least important findings rather than
 * whichever happened to be discovered last, and truncation drops information,
 * never errors. Navigation drift is detected by asking the reindexer what it
 * would change, so this answer can never disagree with what a real pass
 * would do; an empty tree is skipped, since "the reindex would scaffold a
 * PROFILE" describes a wiki that has never been written to, not one that has
 * drifted. The root profile's description is exempt from the placeholder
 * check, because it is generated by design and never a placeholder anyone
 * needs to replace.
 */
export async function health(args: HealthArgs): Promise<MemoryHealthReport> {
  const config = { ...DEFAULT_HEALTH_CONFIG, ...args.config };
  let docs: MemoryDoc[] = [];
  let shape = analyze(docs);
  const perCode = new Map<MemoryHealthCode, number>();
  const findings: MemoryHealthFinding[] = [];
  const skipped: MemoryHealthCode[] = [];
  let incomplete = false;
  let corpusBytes = 0;
  let contentBudgetExhausted = false;

  const skip = (...codes: MemoryHealthCode[]): void => {
    incomplete = true;
    for (const code of codes) if (!skipped.includes(code)) skipped.push(code);
  };

  const add = (
    code: MemoryHealthCode,
    path: string,
    message: string,
    suggested_action: string,
  ): void => {
    const used = perCode.get(code) ?? 0;
    if (used >= config.maxPerCode) return;
    perCode.set(code, used + 1);
    findings.push({
      code,
      severity: SEVERITY[code],
      path,
      message: truncate(sanitizeText(message), TEXT_MAX),
      suggested_action: truncate(sanitizeText(suggested_action), TEXT_MAX),
    });
  };

  try {
    docs = await args.tx.list();
    shape = analyze(docs);
  } catch (error) {
    if (!(error instanceof MemoryStorageLimitError)) throw error;
    // A partial catalog would make every structural/content conclusion
    // misleading. Keep queue/recovery checks useful and mark the tree checks
    // explicitly unavailable instead of failing health or inventing totals.
    skip(...TREE_HEALTH_CODES);
  }

  if (args.recoveryRequired === true) {
    add(
      "recovery_required",
      "",
      "a batch was interrupted and the tree no longer matches what it recorded",
      "Reads still work; resolve the batch to allow writing again.",
    );
  }

  if (docs.length > 0 && !shape.paths.has("PROFILE.md")) {
    add(
      "missing_profile",
      "PROFILE.md",
      "the wiki has no root profile, so nothing links to its topics",
      "Run a reindex to scaffold PROFILE.md.",
    );
  }

  for (const [dir, kids] of shape.children) {
    if (dir === "" || kids.size === 0) continue;
    const index = indexFileFor(dir);
    if (!shape.paths.has(index)) {
      add(
        "missing_topic_index",
        index,
        `${dir} has sub-topics but no index document`,
        "Run a reindex to scaffold it.",
      );
    }
  }

  let reindexChanges: Awaited<ReturnType<typeof planReindex>> = [];
  if (docs.length > 0) {
    try {
      reindexChanges = await planReindex(args.tx);
    } catch (error) {
      if (!(error instanceof MemoryStorageLimitError)) throw error;
      skip("stale_navigation");
    }
  }
  for (const change of reindexChanges) {
    add(
      "stale_navigation",
      change.path,
      "the generated Contents section is out of date",
      "Run a reindex; nothing you wrote is at risk.",
    );
  }

  const reachable = reachableFromProfile(docs, shape);
  for (const doc of docs) {
    if (doc.path !== "PROFILE.md" && !reachable.has(doc.path)) {
      add(
        "orphan_document",
        doc.path,
        "nothing links to this document, so no run will find it by navigating",
        "Move it under an existing topic, or run a reindex.",
      );
    }

    const ageDays = (args.now - doc.updated_at) / 86_400_000;
    if (ageDays > config.staleDays) {
      add(
        "stale_document",
        doc.path,
        `not updated in ${String(Math.floor(ageDays))} days`,
        "Re-verify it, or delete it if it no longer holds.",
      );
    }

    if (contentBudgetExhausted) continue;
    let raw: string | null;
    let truncated = false;
    try {
      if (args.tx.readBounded !== undefined) {
        const bounded = await args.tx.readBounded(doc.path, MEMORY_STORAGE_LIMITS.documentBytes);
        raw = bounded?.text ?? null;
        truncated = bounded?.truncated === true;
      } else {
        raw = await args.tx.read(doc.path);
      }
    } catch (error) {
      if (!(error instanceof MemoryStorageLimitError)) throw error;
      add(
        "document_too_large",
        doc.path,
        `the document is ${String(error.actual)} bytes; storage admits ${String(error.maximum)}`,
        "Split it before Clarvis reads or mutates it.",
      );
      continue;
    }
    if (raw === null) continue;
    const rawBytes = Buffer.byteLength(raw, "utf8");
    if (truncated || rawBytes > MEMORY_STORAGE_LIMITS.documentBytes) {
      add(
        "document_too_large",
        doc.path,
        `the document exceeds the ${String(MEMORY_STORAGE_LIMITS.documentBytes)}-byte storage limit`,
        "Split it before Clarvis reads or mutates it.",
      );
      continue;
    }
    if (corpusBytes + rawBytes > MEMORY_STORAGE_LIMITS.corpusBytes) {
      contentBudgetExhausted = true;
      skip(
        "invalid_frontmatter",
        "missing_description",
        "invalid_authority",
        "empty_document",
        "document_too_large",
        "placeholder_description",
        "description_too_long",
        "unknown_frontmatter_key",
      );
      continue;
    }
    corpusBytes += rawBytes;
    const parsed = parseFrontmatter(raw);

    if (parsed.unparsable) {
      add(
        "invalid_frontmatter",
        doc.path,
        "the frontmatter block is opened but never closed, so the document will not load",
        "Close the block with a `---` line; nothing will rewrite it until you do.",
      );
      continue;
    }
    if (parsed.frontmatter.description.trim() === "") {
      add(
        "missing_description",
        doc.path,
        "no description, so parent indexes cannot describe this document",
        "Add a one-line `description:` to the frontmatter.",
      );
    } else if (parsed.frontmatter.description.length > DESCRIPTION_MAX_CHARS) {
      add(
        "description_too_long",
        doc.path,
        `the description is ${String(parsed.frontmatter.description.length)} characters`,
        `Shorten it to ${String(DESCRIPTION_MAX_CHARS)}; parent indexes truncate it.`,
      );
    } else if (
      doc.path !== "PROFILE.md" &&
      isGeneratedPlaceholder(parsed.frontmatter.description, dirOfPath(doc.path))
    ) {
      add(
        "placeholder_description",
        doc.path,
        "the description is the generated placeholder, not a real summary",
        "Replace it with a line describing what this document holds.",
      );
    }

    for (const line of parsed.frontmatter.extra ?? []) {
      const key = line
        .slice(0, Math.max(0, line.indexOf(":")))
        .trim()
        .toLowerCase();
      if (key === "authority") {
        add(
          "invalid_authority",
          doc.path,
          `\`${line.trim()}\` is not a recognized authority`,
          "Use observed, confirmed or contested.",
        );
      } else if (!KNOWN_KEYS.has(key)) {
        add(
          "unknown_frontmatter_key",
          doc.path,
          `\`${key || line.trim()}\` is not a key this package reads`,
          "It is preserved as written; remove it if it was a typo.",
        );
      }
    }

    const body = parsed.body.replace(/^#[^\n]*\n?/, "").replace(/^## Contents[\s\S]*$/m, "");
    if (body.trim() === "") {
      add(
        "empty_document",
        doc.path,
        "the document has a heading and navigation but no content",
        "Write something worth remembering, or delete it.",
      );
    }
    if (parsed.body.length > config.maxDocumentChars) {
      add(
        "document_too_large",
        doc.path,
        `the body is ${String(parsed.body.length)} characters`,
        "Split it into sub-topics; it no longer fits the indexer's context well.",
      );
    }
  }

  let pendingJobs = 0;
  let failedJobs = 0;
  if (args.jobs === undefined) {
    skipped.push("failed_index_job", "stuck_index_job");
  } else {
    const counts = await args.jobs.counts();
    pendingJobs = counts.pending + counts.retry_wait;
    failedJobs = counts.failed;
    for (const job of await args.jobs.list({ state: "failed", limit: config.maxPerCode })) {
      const last = job.history[job.history.length - 1];
      add(
        "failed_index_job",
        job.run_id,
        `learning from this run gave up after ${String(job.attempts)} attempts` +
          (last === undefined ? "" : `: ${last.phase} — ${last.error}`),
        "Retry the job once the cause is addressed, or discard it.",
      );
    }
    const stuckBefore = args.now - config.stuckJobMinutes * 60_000;
    for (const job of await args.jobs.list({ state: "running", limit: config.maxPerCode })) {
      if (job.updated_at > stuckBefore) continue;
      add(
        "stuck_index_job",
        job.run_id,
        "this job has been claimed far longer than an index pass should take",
        "Its claim expires on its own; retry it if it does not.",
      );
    }
  }

  const deduped = new Map<string, MemoryHealthFinding>();
  for (const f of findings) deduped.set(`${f.code}|${f.path}|${f.message}`, f);
  const sorted = [...deduped.values()].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byCode = HEALTH_CODES.indexOf(a.code) - HEALTH_CODES.indexOf(b.code);
    if (byCode !== 0) return byCode;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });

  const kept = sorted.slice(0, config.maxFindings);
  const counts: Record<MemoryHealthSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of kept) counts[f.severity] += 1;

  return {
    generated_at: args.now,
    totals: {
      documents: docs.length,
      topics: docs.filter((d) => d.kind === "topic").length,
      memories: docs.filter((d) => d.kind === "memory").length,
      pending_jobs: pendingJobs,
      failed_jobs: failedJobs,
    },
    counts,
    findings: kept,
    truncated: incomplete || kept.length < sorted.length,
    skipped_codes: skipped,
  };
}

/** POSIX dirname, duplicated here to keep `tree.ts`'s own helper private. */
function dirOfPath(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i < 0 ? "" : relPath.slice(0, i);
}

/**
 * Every document reachable by walking down from the root profile.
 *
 * @param docs - the tree listing.
 * @param shape - the analyzed hierarchy.
 * @returns the reachable paths.
 * @remarks Reachability follows the directory hierarchy, which is exactly what
 * the generated navigation links, so an unreachable document is one no run will
 * find by drilling down — however much it is worth.
 */
function reachableFromProfile(
  docs: readonly MemoryDoc[],
  shape: ReturnType<typeof analyze>,
): Set<string> {
  const reachable = new Set<string>();
  if (!shape.paths.has("PROFILE.md") && docs.length > 0) return reachable;
  const seen = new Set<string>();
  const stack = [""];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const doc of docs) {
      if (dirOfPath(doc.path) === dir) reachable.add(doc.path);
    }
    for (const kid of shape.children.get(dir) ?? []) stack.push(kid);
  }
  return reachable;
}
