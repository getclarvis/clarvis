import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

import { DIR_MODE, FILE_MODE } from "./constants.ts";
import { pathsLogger, type PathsLogger } from "./diag.ts";

/**
 * The conservative budget for a POSIX endpoint address.
 *
 * @remarks
 * `sockaddr_un.sun_path` is 108 bytes on Linux and 104 on Darwin, and a caller
 * that spends the whole array has no room left for the terminator. This is the
 * budget the reconnectable local-host endpoint is already selected against.
 */
export const UNIX_SOCKET_PATH_BUDGET_BYTES = 100;

/**
 * The preferred budget for a POSIX scratch root.
 *
 * @remarks
 * A scratch root is a *parent* of paths nobody has chosen yet — a socket a tool
 * invents under `TMPDIR`, a nested fixture, a deep package directory. Spending
 * forty bytes on the root leaves each of them useful margin. It is a preference,
 * not a promise: a host whose candidates are all longer still gets scratch, it
 * just does not get the margin.
 */
export const SHORT_SCRATCH_BUDGET_BYTES = 40;

/** Bytes of randomness in one allocation id: 48 bits, base64url, eight characters. */
const ALLOCATION_ID_BYTES = 6;

/** Characters one allocation id occupies: base64url of {@link ALLOCATION_ID_BYTES}. */
const ALLOCATION_ID_LENGTH = (ALLOCATION_ID_BYTES * 4) / 3;

/**
 * The only names a recovery pass may treat as an allocation id.
 *
 * @remarks The pass derives a removal path from a directory listing and the id is
 *   its last component, so `.`, `..` and an empty stem would collapse that path
 *   onto the shared container instead of one allocation. A plain single component
 *   is the rule the pass enforces; the allocator itself draws
 *   {@link ALLOCATION_ID_LENGTH} base64url characters, which this accepts, so a
 *   differently derived id cannot silently become uncollectable.
 */
const ALLOCATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Bounded retries when a racing or hostile creator already claimed a drawn id. */
const ALLOCATION_ATTEMPTS = 8;

/** The account-private container every allocation of one account lives under. */
const CONTAINER_PREFIX = "clv-";

/** Allocations live under `<container>/r`, their recovery metadata under `<container>/a`. */
const ALLOCATION_DIR = "r";
const METADATA_DIR = "a";

/** Allocation metadata schema version. */
const METADATA_SCHEMA = 1;

/** Default grace before an abandoned allocation with no content may be collected. */
const DEFAULT_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

/** Default bound on the entries one sweep pass examines per directory of a container. */
const DEFAULT_SWEEP_ENTRIES = 1_000;

/**
 * How one account's own container is named on disk.
 *
 * @remarks A shared temporary base separates accounts with this segment.
 */
function accountSegment(): string {
  return `u${process.getuid?.() ?? 0}`;
}

/**
 * Why a directory chain may not host Clarvis-private state.
 *
 * @remarks
 * The vocabulary is closed and reported as data rather than as a batch of
 * booleans: a selection that silently drops a candidate is the failure this
 * helper exists to make legible.
 */
export type AncestorTrustRefusal =
  "unreadable" | "not_a_directory" | "symlink" | "foreign_owner" | "group_or_world_writable";

/** The verdict of {@link ancestorTrust} for one path. */
export type AncestorTrust =
  { trusted: true } | { trusted: false; refusal: AncestorTrustRefusal; path: string };

/** Test seams for {@link ancestorTrust}. */
export interface AncestorTrustOptions {
  /**
   * The account id treated as the owner; defaults to `process.getuid()`.
   *
   * @remarks A seam for exercising the foreign-owner verdict without a second
   *   account. Production callers omit it and get the real account, which is what
   *   keeps the shared policy identical to the one the kernel enforced itself.
   */
  accountUid?: number;
}

/**
 * Decide whether every ancestor of `path` is a directory Clarvis may keep private
 * state beneath.
 *
 * @param path - the private path whose *ancestors* are judged; the path itself is
 *   not examined here.
 * @param opts - see {@link AncestorTrustOptions}.
 * @returns `{ trusted: true }`, or the first offending ancestor and why.
 *
 * @remarks
 * The policy this shares with `@clarvis/kernel`'s private-host verification:
 * every ancestor from the parent upward must be a real directory (never a
 * symlink), owned by the filesystem root's owner or the current account, and not
 * group- or world-writable unless it is sticky. `/tmp` on a host whose root is
 * owned by another account fails it, which is the point — accepting a
 * foreign-owned root is how a run ends up unable to publish its own private
 * state at all.
 *
 * Any read failure is a refusal, never an assumption of trust.
 */
export function ancestorTrust(path: string, opts: AncestorTrustOptions = {}): AncestorTrust {
  const resolved = resolve(path);
  const rootOwner = lstatSync(parse(resolved).root).uid;
  const account = opts.accountUid ?? process.getuid?.();
  for (let parent = dirname(resolved); ;) {
    let ancestor;
    try {
      ancestor = lstatSync(parent);
    } catch {
      return { trusted: false, refusal: "unreadable", path: parent };
    }
    if (ancestor.isSymbolicLink()) return { trusted: false, refusal: "symlink", path: parent };
    if (!ancestor.isDirectory())
      return { trusted: false, refusal: "not_a_directory", path: parent };
    if (ancestor.uid !== rootOwner && ancestor.uid !== account)
      return { trusted: false, refusal: "foreign_owner", path: parent };
    if ((ancestor.mode & 0o022) !== 0 && (ancestor.mode & 0o1000) === 0)
      return { trusted: false, refusal: "group_or_world_writable", path: parent };
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return { trusted: true };
}

/**
 * Whether a POSIX endpoint address fits {@link UNIX_SOCKET_PATH_BUDGET_BYTES}.
 *
 * @param path - the complete endpoint path, as it will be passed to `bind`/`listen`.
 * @param budgetBytes - the budget to apply; defaults to the POSIX endpoint budget.
 * @returns `true` when the address fits in UTF-8 bytes.
 */
export function unixSocketPathFits(
  path: string,
  budgetBytes: number = UNIX_SOCKET_PATH_BUDGET_BYTES,
): boolean {
  return Buffer.byteLength(path, "utf8") <= budgetBytes;
}

/** Options for {@link shortTemporaryRootCandidates}. */
export interface ShortTemporaryCandidateOptions {
  /** Host platform; injectable for cross-platform tests. */
  platform?: NodeJS.Platform;
  /** Ordered candidate roots; defaults to the platform's standard temporary roots. */
  candidates?: readonly string[];
  /** Reject a candidate without an account-owned ancestor chain; defaults to `true`. */
  requireTrustedAncestors?: boolean;
  /**
   * Budget the complete allocation path shape should fit; defaults to
   * {@link SHORT_SCRATCH_BUDGET_BYTES}.
   *
   * @remarks A preference unless {@link ShortTemporaryCandidateOptions.requireBudget}
   *   is set: candidates that fit are returned first and the rest still follow, so a
   *   host whose every temporary root is long still gets scratch. The endpoint
   *   budget is the one that is enforced rather than preferred.
   */
  budgetBytes?: number;
  /** Drop candidates that do not fit {@link ShortTemporaryCandidateOptions.budgetBytes}. */
  requireBudget?: boolean;
  /** Where to report a rejected candidate; defaults to the process-wide sink. */
  logger?: PathsLogger;
}

/** The candidate bases for a platform, before any validation. */
function rawCandidates(supplied?: readonly string[]): readonly string[] {
  if (supplied !== undefined) {
    if (supplied.length === 0) throw new Error("short temporary root candidates must not be empty");
    return [...supplied];
  }
  const ordered = [process.env.XDG_RUNTIME_DIR, "/tmp", "/dev/shm", tmpdir()];
  return [
    ...new Set(ordered.filter((value): value is string => value !== undefined && value !== "")),
  ];
}

/** The allocation-shaped path one candidate base would produce. */
function allocationShape(base: string): string {
  return join(
    base,
    `${CONTAINER_PREFIX}${accountSegment()}`,
    ALLOCATION_DIR,
    "x".repeat(ALLOCATION_ID_LENGTH),
  );
}

/**
 * A placeholder child of a candidate base, so the base itself is judged.
 *
 * @remarks The kernel judges every ancestor of the private path it is handed, and
 *   an allocation's container is the candidate's own child — so a candidate whose
 *   own owner or mode is wrong must be rejected here, not discovered later by the
 *   component that publishes private state beneath it.
 */
const TRUST_PROBE_CHILD = "allocation";

/**
 * The ordered, canonical, usable roots for a short temporary allocation.
 *
 * @param opts - see {@link ShortTemporaryCandidateOptions}.
 * @returns canonical base directories, best first; empty when none qualifies.
 *
 * @remarks
 * A candidate qualifies when it exists as a real directory, canonicalizes, and —
 * unless the caller opts out — has an account-owned ancestor chain per
 * {@link ancestorTrust}, which also judges the candidate itself because an
 * allocation's container is its child. Candidates whose allocation shape fits
 * {@link ShortTemporaryCandidateOptions.budgetBytes} come first; the rest follow
 * unless the caller requires the budget. Selection performs filesystem *reads*
 * only: nothing is created, repaired or chmod'ed here, so a rejected candidate is
 * left exactly as it was found.
 */
export function shortTemporaryRootCandidates(
  opts: ShortTemporaryCandidateOptions = {},
): readonly string[] {
  const budget = opts.budgetBytes ?? SHORT_SCRATCH_BUDGET_BYTES;
  const requireTrust = opts.requireTrustedAncestors ?? true;
  const requireBudget = opts.requireBudget ?? false;
  const logger = opts.logger ?? pathsLogger();
  const accepted: string[] = [];
  const roomy: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawCandidates(opts.candidates)) {
    const reject = (reason: string, candidate: string): void => {
      logger.debug(
        { event: "paths.temporary_root_candidate_rejected", candidate, reason },
        "a short temporary root candidate was rejected during selection",
      );
    };
    let canonical: string;
    try {
      if (!lstatSync(resolve(raw)).isDirectory()) {
        reject("not_a_directory", raw);
        continue;
      }
      canonical = resolve(realpathSync(resolve(raw)));
      if (seen.has(canonical)) continue;
      const fits = unixSocketPathFits(allocationShape(canonical), budget);
      if (!fits && requireBudget) {
        reject("budget", canonical);
        continue;
      }
      if (requireTrust) {
        const trust = ancestorTrust(join(canonical, TRUST_PROBE_CHILD));
        if (!trust.trusted) {
          reject(`untrusted_ancestors:${trust.refusal}:${trust.path}`, canonical);
          continue;
        }
      }
      seen.add(canonical);
      (fits ? accepted : roomy).push(canonical);
    } catch {
      reject("unusable", raw);
    }
  }
  return [...accepted, ...roomy];
}

/** Options for {@link allocateShortTemporaryRoot}. */
export interface ShortTemporaryRootOptions extends ShortTemporaryCandidateOptions {
  /** Short stable label recorded in metadata; never part of the directory name. */
  label: string;
  /** Caller-owned identity recorded in metadata only, such as a run execution id. */
  identity?: string;
  /**
   * Draw the next allocation id; defaults to fresh randomness.
   *
   * @remarks A seam for exercising the collision and rejection paths of
   *   {@link allocateShortTemporaryRoot} deterministically. Production callers
   *   omit it, and every other consequence of the id is unchanged.
   */
  nextId?: () => string;
  /** Injectable clock for the metadata timestamp. */
  now?: () => number;
}

/**
 * One exclusive, account-owned scratch directory.
 *
 * @remarks
 * `remove` is the only lifecycle operation and it is idempotent. It never
 * repairs, chmods or deletes through a path it cannot first prove is this
 * allocation, so a name that was replaced underneath it is reported rather than
 * recursively removed.
 */
export interface ShortTemporaryRoot {
  /** The canonical scratch directory. */
  path: string;
  /** The allocation id, also the metadata filename stem. */
  id: string;
  /** The label recorded in metadata. */
  label: string;
  /** Remove this allocation; safe to call more than once. */
  remove(): void;
}

/** The allocation metadata written beside an allocation for crash recovery. */
interface AllocationMetadata {
  schema: typeof METADATA_SCHEMA;
  id: string;
  label: string;
  identity?: string;
  pid: number;
  host: string;
  created_at: number;
}

/** Whether `path` is a regular directory owned by this account, owner-only. */
function isOwnedDirectory(path: string): boolean {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  if (process.getuid !== undefined && info.uid !== process.getuid()) return false;
  return (info.mode & 0o777) === DIR_MODE;
}

/** Reject anything Clarvis did not create as an owner-only directory of this account. */
function assertOwnedDirectory(path: string): void {
  if (!isOwnedDirectory(path))
    throw new Error("short temporary directory is not an owner-only directory of this account");
}

/**
 * Ensure `<base>/<container>` and its two subtrees exist and are this account's.
 *
 * @throws when an existing container is not a real, owner-only directory of this
 *   account; such a container is never repaired or adopted.
 */
function ensureContainer(base: string, logger: PathsLogger): string {
  const container = join(base, `${CONTAINER_PREFIX}${accountSegment()}`);
  try {
    mkdirSync(container, { recursive: false, mode: DIR_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertOwnedDirectory(container);
  for (const name of [ALLOCATION_DIR, METADATA_DIR]) {
    const dir = join(container, name);
    try {
      mkdirSync(dir, { recursive: false, mode: DIR_MODE });
      chmodSync(dir, DIR_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    assertOwnedDirectory(dir);
  }
  logger.debug(
    { event: "paths.temporary_container_ready", container },
    "the account's shared short temporary container is ready",
  );
  return container;
}

/** One fresh, exclusively created allocation under `container`, or `undefined`. */
function createAllocation(
  container: string,
  nextId: () => string,
): { id: string; path: string } | undefined {
  for (let attempt = 0; attempt < ALLOCATION_ATTEMPTS; attempt += 1) {
    const id = nextId();
    const path = join(container, ALLOCATION_DIR, id);
    try {
      mkdirSync(path, { recursive: false, mode: DIR_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    chmodSync(path, DIR_MODE);
    assertOwnedDirectory(path);
    return { id, path };
  }
  return undefined;
}

/**
 * Create a short, exclusive, account-owned scratch directory.
 *
 * @param opts - see {@link ShortTemporaryRootOptions}.
 * @returns the allocation and its idempotent {@link ShortTemporaryRoot.remove}.
 * @throws when no candidate root accepts an allocation; the message names the
 *   label, the platform and the budget, and every rejection is also reported as
 *   `paths.temporary_root_candidate_rejected` during selection or as
 *   `paths.temporary_root_allocation_failed` when a candidate could not host the
 *   allocation.
 *
 * @remarks
 * The directory name carries only a random id, never the run's identity: the
 * identity lives in `<container>/a/<id>.json`, which the agent's own commands
 * cannot see or forge and which a later recovery pass reads. An existing entry is
 * never adopted — a collision draws a new id, and a pre-existing container is
 * accepted only when its type, owner and mode are exactly Clarvis's own.
 */
export function allocateShortTemporaryRoot(opts: ShortTemporaryRootOptions): ShortTemporaryRoot {
  const logger = opts.logger ?? pathsLogger();
  const platform = opts.platform ?? process.platform;
  const budget = opts.budgetBytes ?? SHORT_SCRATCH_BUDGET_BYTES;
  const ordered = shortTemporaryRootCandidates({
    ...opts,
    platform,
    budgetBytes: budget,
    requireTrustedAncestors: opts.requireTrustedAncestors ?? true,
    logger,
  });
  for (const base of ordered) {
    try {
      const container = ensureContainer(base, logger);
      const created = createAllocation(
        container,
        opts.nextId ?? (() => randomBytes(ALLOCATION_ID_BYTES).toString("base64url")),
      );
      if (created === undefined) {
        logger.warn(
          {
            event: "paths.temporary_root_allocation_failed",
            label: opts.label,
            base,
            reason: "collision",
          },
          "every drawn allocation id collided in this container",
        );
        continue;
      }
      const metadata: AllocationMetadata = {
        schema: METADATA_SCHEMA,
        id: created.id,
        label: opts.label,
        ...(opts.identity === undefined ? {} : { identity: opts.identity }),
        pid: process.pid,
        host: hostname(),
        created_at: (opts.now ?? Date.now)(),
      };
      const record = join(container, METADATA_DIR, `${created.id}.json`);
      try {
        writeFileSync(record, `${JSON.stringify(metadata)}\n`, { flag: "wx", mode: FILE_MODE });
        chmodSync(record, FILE_MODE);
      } catch (error) {
        rmSync(created.path, { recursive: true, force: true });
        logger.warn(
          {
            event: "paths.temporary_root_allocation_failed",
            label: opts.label,
            base,
            reason: "metadata",
            code: (error as NodeJS.ErrnoException).code ?? "unknown",
          },
          "an allocation could not publish its recovery metadata and was removed again",
        );
        continue;
      }
      logger.debug(
        {
          event: "paths.temporary_root_allocated",
          path: created.path,
          label: opts.label,
          bytes: Buffer.byteLength(created.path, "utf8"),
        },
        "a short temporary root was allocated",
      );
      return {
        path: created.path,
        id: created.id,
        label: opts.label,
        remove(): void {
          const info = lstatSync(created.path, { throwIfNoEntry: false });
          if (info === undefined) {
            rmSync(record, { force: true });
            return;
          }
          if (!isOwnedDirectory(created.path)) {
            logger.warn(
              {
                event: "paths.temporary_root_cleanup_failed",
                path: created.path,
                label: opts.label,
                reason: "identity_changed",
              },
              "an allocation was no longer the directory it was created as and was left in place",
            );
            return;
          }
          try {
            rmSync(created.path, { recursive: true, force: true });
            rmSync(record, { force: true });
          } catch (error) {
            logger.warn(
              {
                event: "paths.temporary_root_cleanup_failed",
                path: created.path,
                label: opts.label,
                reason: "remove_failed",
                code: (error as NodeJS.ErrnoException).code ?? "unknown",
              },
              "a run-owned short temporary root could not be removed",
            );
          }
        },
      };
    } catch (error) {
      logger.warn(
        {
          event: "paths.temporary_root_allocation_failed",
          label: opts.label,
          base,
          reason: "unusable",
          code: (error as NodeJS.ErrnoException).code ?? "unknown",
        },
        "a short temporary root candidate could not host an allocation",
      );
    }
  }
  throw new Error(
    `short_temporary_root_unavailable: no candidate root accepted an allocation for label ` +
      `'${opts.label}' (platform ${platform}, budget ${budget})`,
  );
}

/** Options for {@link collectAbandonedShortTemporaryRoots}. */
export interface ShortTemporarySweepOptions extends ShortTemporaryCandidateOptions {
  /** Maximum entries examined per directory of one container; defaults to 1000. */
  maxEntries?: number;
  /** Minimum age before an allocation with no content may be collected. */
  graceMs?: number;
  /** Injectable clock. */
  now?: () => number;
  /** Injectable liveness probe; defaults to a same-host `process.kill(pid, 0)`. */
  isProcessAlive?: (pid: number) => boolean;
  /** Injectable host identity; defaults to {@link hostname}. */
  host?: string;
}

/** What one {@link collectAbandonedShortTemporaryRoots} pass did. */
export interface ShortTemporarySweepReport {
  /** Containers inspected. */
  containers: number;
  /** Metadata records read. */
  records: number;
  /** Allocations removed. */
  removed: number;
  /** Allocations kept because their recorded process is alive, or they are recent. */
  preservedActive: number;
  /** Allocations kept because they hold content a run may still own. */
  preservedContent: number;
  /** Entries kept because ownership, host or metadata could not be verified. */
  preservedUnverified: number;
  /** Whether a scan bound stopped the pass early. */
  truncated: boolean;
}

/**
 * Whether an allocation subtree holds nothing a run could still own.
 *
 * @param path - the allocation directory.
 * @returns `true` only when every entry beneath it, at any depth, is a real
 *   directory.
 *
 * @remarks The walk is explicit rather than `readdirSync(..., { recursive: true })`
 *   because Bun follows a symlinked directory during a recursive listing while
 *   Node does not: one link a run left to a tree it does not own would spend a
 *   whole pass there, and every later pass again. A symlink, a file or any other
 *   entry refuses the allocation immediately, so a target is never entered.
 */
function holdsOnlyDirectories(path: string): boolean {
  const pending = [path];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
      pending.push(join(current, entry.name));
    }
  }
  return true;
}

/**
 * Whether a dead allocation can be removed without losing anything.
 *
 * @param directory - the allocation directory.
 * @param info - its `lstat`, already read by the caller.
 * @returns `true` only for this account's real directory with no files, no
 *   symlinks and no contents at all beneath it. A read failure is `false`.
 */
function holdsNothing(directory: string, info: Stats): boolean {
  try {
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    if (process.getuid !== undefined && info.uid !== process.getuid()) return false;
    return holdsOnlyDirectories(directory);
  } catch {
    return false;
  }
}

/** Conservative same-host liveness: a failure other than ESRCH is never proof of death. */
function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== "ESRCH";
  }
  return true;
}

/** Read one allocation record, or `undefined` when it is missing or unrecognised. */
function readMetadata(file: string): AllocationMetadata | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Partial<AllocationMetadata>;
  if (
    record.schema !== METADATA_SCHEMA ||
    typeof record.id !== "string" ||
    typeof record.label !== "string" ||
    typeof record.pid !== "number" ||
    typeof record.host !== "string" ||
    typeof record.created_at !== "number"
  )
    return undefined;
  return {
    schema: METADATA_SCHEMA,
    id: record.id,
    label: record.label,
    ...(typeof record.identity === "string" ? { identity: record.identity } : {}),
    pid: record.pid,
    host: record.host,
    created_at: record.created_at,
  };
}

/**
 * Collect abandoned short temporary allocations, preserving everything that is
 * not provably dead and empty.
 *
 * @param opts - see {@link ShortTemporarySweepOptions}.
 * @returns the pass's report, also logged once as `paths.temporary_root_sweep`.
 *
 * @remarks
 * A record authorises removal only when all of the following hold: its file name
 * is a plain allocation id — a single component that is neither `.` nor `..`, so
 * the path derived from it cannot collapse onto the shared container — its schema
 * is known, its host is this host, its process is provably dead on this host, it is
 * older than the grace, its directory is still a real directory of this account,
 * and its whole subtree contains no files and no symlinks. Age, a plain id or a
 * lone PID never authorise a recursive removal on their own, and an allocation with
 * no readable record is never a candidate at all — which is what keeps a crashed
 * run's output available to whoever is still looking at it.
 *
 * A record is evidence written by the allocating process, not a statement this
 * pass can authenticate, so the pass assumes same-account cooperation and refuses
 * to reclaim anything that could still be someone's. That is also why the walk
 * descends only into real directories, never through a symlink, whose target the
 * allocation does not own.
 */
export async function collectAbandonedShortTemporaryRoots(
  opts: ShortTemporarySweepOptions = {},
): Promise<ShortTemporarySweepReport> {
  const logger = opts.logger ?? pathsLogger();
  const platform = opts.platform ?? process.platform;
  const budget = opts.budgetBytes ?? SHORT_SCRATCH_BUDGET_BYTES;
  const maxEntries = Math.max(0, opts.maxEntries ?? DEFAULT_SWEEP_ENTRIES);
  const graceMs = opts.graceMs ?? DEFAULT_SWEEP_GRACE_MS;
  const now = (opts.now ?? Date.now)();
  const host = opts.host ?? hostname();
  const alive = opts.isProcessAlive ?? processAlive;
  const report: ShortTemporarySweepReport = {
    containers: 0,
    records: 0,
    removed: 0,
    preservedActive: 0,
    preservedContent: 0,
    preservedUnverified: 0,
    truncated: false,
  };
  for (const base of shortTemporaryRootCandidates({
    ...opts,
    platform,
    budgetBytes: budget,
    requireTrustedAncestors: opts.requireTrustedAncestors ?? true,
    logger,
  })) {
    const container = join(base, `${CONTAINER_PREFIX}${accountSegment()}`);
    let entries;
    try {
      entries = readdirSync(join(container, METADATA_DIR), { withFileTypes: true });
    } catch {
      continue;
    }
    report.containers += 1;
    let scanned = 0;
    for (const entry of entries) {
      if (scanned >= maxEntries) {
        report.truncated = true;
        break;
      }
      scanned += 1;
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        report.preservedUnverified += 1;
        continue;
      }
      report.records += 1;
      const id = entry.name.slice(0, -".json".length);
      if (!ALLOCATION_ID_PATTERN.test(id)) {
        report.preservedUnverified += 1;
        continue;
      }
      const recordFile = join(container, METADATA_DIR, entry.name);
      const directory = join(container, ALLOCATION_DIR, id);
      const record = readMetadata(recordFile);
      if (record === undefined || record.host !== host || record.id !== id) {
        report.preservedUnverified += 1;
        continue;
      }
      if (alive(record.pid) || now - record.created_at < graceMs) {
        report.preservedActive += 1;
        continue;
      }
      const info = lstatSync(directory, { throwIfNoEntry: false });
      if (info === undefined) {
        await rm(recordFile, { force: true }).catch(() => undefined);
        continue;
      }
      if (!holdsNothing(directory, info)) {
        report.preservedContent += 1;
        continue;
      }
      try {
        await rm(directory, { recursive: true, force: true });
        await rm(recordFile, { force: true });
        report.removed += 1;
      } catch {
        report.preservedUnverified += 1;
      }
    }
    let allocationEntries = 0;
    try {
      for (const entry of readdirSync(join(container, ALLOCATION_DIR), { withFileTypes: true })) {
        if (allocationEntries >= maxEntries) {
          report.truncated = true;
          break;
        }
        allocationEntries += 1;
        if (!existsSync(join(container, METADATA_DIR, `${entry.name}.json`)))
          report.preservedUnverified += 1;
      }
    } catch {}
  }
  logger.debug(
    {
      event: "paths.temporary_root_sweep",
      containers: report.containers,
      records: report.records,
      removed: report.removed,
      preserved_active: report.preservedActive,
      preserved_content: report.preservedContent,
      preserved_unverified: report.preservedUnverified,
      truncated: report.truncated,
    },
    "a short temporary root pass finished; only provably dead and empty allocations were removed",
  );
  return report;
}
