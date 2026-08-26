import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { ensureWorkspaceLocalDir, workspaceStatePaths } from "@clarvis/paths";
import { sanitizeErrorMessage } from "@clarvis/kernel/policy";
import {
  DEFAULT_DIAGNOSTIC_LEVEL,
  DIAGNOSTIC_LEVELS,
  type DiagnosticDetails,
  type DiagnosticLevel,
  type DiagnosticLogger,
  type DiagnosticSession,
} from "../core/diagnostic-events.ts";

const FORMAT_VERSION = 1;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_KEEP_FILES = 5;
const FILE_PREFIX = "code-debug-";
const FILE_SUFFIX = ".jsonl";
const REDACTED = "[redacted]";
const MAX_STRING_LENGTH = 2_000;
const MAX_ARRAY_ITEMS = 32;
const MAX_OBJECT_KEYS = 64;
const MAX_DEPTH = 5;
const MAX_COUNTERS = 256;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_EVENT_NAME_LENGTH = 160;
/**
 * How often the diagnostic session emits a liveness record while idle.
 *
 * @remarks A heartbeat's only job is to distinguish "nothing happened" from
 * "the process stopped writing", so it has to be frequent enough that a gap is
 * legible against it and rare enough that an idle session is not writing a log
 * of its own idleness. Five seconds gives a reader an unambiguous gap within a
 * few missed beats.
 */
const HEARTBEAT_MS = 5_000;
/**
 * Nodes one record's payload is walked through before sanitization gives up.
 *
 * @remarks A diagnostic record is a *field set*, not a document; a payload past
 * this size is a caller having handed a whole object graph to a log line, which
 * is the case this bound exists to refuse rather than to serve. It sits with the
 * other structural bounds above ({@link MAX_OBJECT_KEYS},
 * {@link MAX_DEPTH}) and, like them, is set where hand-written bindings stop and
 * an accident begins.
 */
const MAX_SANITIZE_NODES = 256;
const MAX_STRING_SCAN = 4_096;
const FINAL_RESERVE_BYTES = 4_096;
const ANSI_CSI = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
/**
 * How often a `debug`/`info` record still carries a memory snapshot.
 *
 * @remarks `process.memoryUsage()` is a syscall-backed read and the object it
 * returns costs ~110 bytes of every line, for data that is only ever *read* on
 * the RSS-fuse events — which are `warn` or `error` and therefore never
 * sampled away. The rest is a periodic reference point, not a measurement.
 */
const MEMORY_SAMPLE_EVERY = 32;
/** Envelope keys a binding may not overwrite, because a reader keys on them. */
const RESERVED_ENVELOPE_KEYS = new Set([
  "v",
  "at",
  "seq",
  "level",
  "source",
  "event",
  "pid",
  "memory",
  "details",
]);

export interface DiagnosticSessionOptions {
  /** Workspace whose machine-local state owns the log. */
  workspace?: string;
  /** Injectable directory seam for tests. */
  directory?: string;
  maxBytes?: number;
  keepFiles?: number;
  now?: () => number;
  pid?: number;
  /**
   * The floor below which a record is discarded.
   *
   * @defaultValue `"debug"`, which records everything and is what `--debug`
   * with no level asks for.
   */
  level?: DiagnosticLevel;
}

function levelRank(level: DiagnosticLevel): number {
  return DIAGNOSTIC_LEVELS.indexOf(level);
}

const SECRET_KEY =
  /(?:^|_)(?:api_?key|authorization|cookie|credential|password|secret|token)(?:$|_)/i;
/**
 * Keys whose *value* is content rather than an identifier, and so is withheld.
 *
 * @remarks `path` is deliberately absent, though it looks like it belongs. This
 * classifier only ever runs over a diagnostic payload, where a path is the
 * identifier you are looking for — and including it meant the session's own
 * `diagnostics.start` record wrote `"path": "[redacted]"`, withholding the
 * location of the very file it was writing. A secret embedded in a path string
 * is still caught, by {@link safeString}.
 *
 * `stderr` stays, because a field named that is a captured blob of unknown
 * provenance. Third-party output that has been deliberately bounded and
 * attributed travels as `server_output` instead.
 */
const CONTENT_KEY =
  /^(?:args|arguments|body|clipboard|content|diff|env|headers|input|messages|output|params|payload|prompt|raw_key|request|response|result|stderr|stdin|stdout|input_text|output_text|message_content|prompt_text|request_body|response_body|tool_arguments)$/i;

function classifiedKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-.\s]+/g, "_")
    .toLowerCase();
}

function mustRedactKey(value: string): boolean {
  const normalized = classifiedKey(value);
  return (
    SECRET_KEY.test(normalized) ||
    /(?:^|_)private_?key(?:$|_)/i.test(normalized) ||
    CONTENT_KEY.test(normalized)
  );
}

function safeString(value: string): string {
  const clipped = value.slice(0, MAX_STRING_SCAN);
  const scrubbed = sanitizeErrorMessage(clipped).replaceAll(ANSI_CSI, "");
  const omitted = Math.max(0, value.length - clipped.length);
  return scrubbed.length <= MAX_STRING_LENGTH
    ? `${scrubbed}${omitted > 0 ? `...[truncated ${omitted} chars before redaction]` : ""}`
    : `${scrubbed.slice(0, MAX_STRING_LENGTH)}...[truncated ${
        scrubbed.length - MAX_STRING_LENGTH + omitted
      } chars]`;
}

interface SanitizeBudget {
  remainingNodes: number;
}

/**
 * Reduce an arbitrary logged payload to something safe and bounded to write.
 *
 * @remarks `seen` tracks the current *path* rather than every object visited, so
 * it is unwound as the recursion returns. Retaining it turned an ordinary
 * repeated reference into `"[circular]"` and dropped the very value the
 * diagnostic was written to capture.
 */
function sanitize(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
  budget: SanitizeBudget = { remainingNodes: MAX_SANITIZE_NODES },
): unknown {
  if (budget.remainingNodes-- <= 0) return "[node-limit]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return safeString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.toString();
  if (depth >= MAX_DEPTH) return "[depth-limit]";
  if (value instanceof Error) {
    return {
      name: safeString(value.name),
      message: safeString(value.message),
    };
  }
  if (typeof value !== "object") return safeString(String(value));
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitize(item, depth + 1, seen, budget));
    seen.delete(value);
    return items;
  }

  const output: Record<string, unknown> = {};
  let keys = 0;
  let truncated = false;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (keys++ >= MAX_OBJECT_KEYS) {
      truncated = true;
      break;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    const item = "value" in descriptor ? descriptor.value : "[accessor]";
    output[key] = mustRedactKey(key) ? REDACTED : sanitize(item, depth + 1, seen, budget);
  }
  if (truncated) output.__truncated_keys = true;
  seen.delete(value);
  return output;
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

function validDiagnosticName(value: string): boolean {
  return value.length <= MAX_EVENT_NAME_LENGTH && /^[a-z0-9][a-z0-9._-]*$/.test(value);
}

function eventName(value: string): string {
  return validDiagnosticName(value) ? value : "diagnostics.invalid-event";
}

function counterName(value: string): string {
  return validDiagnosticName(value) ? value : "diagnostics.invalid-counter";
}

function diagnosticFiles(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX))
      .sort((left, right) => {
        try {
          return statSync(join(directory, left)).mtimeMs - statSync(join(directory, right)).mtimeMs;
        } catch {
          return left.localeCompare(right);
        }
      });
  } catch {
    return [];
  }
}

function retainNewest(directory: string, keepFiles: number): void {
  const files = diagnosticFiles(directory);
  while (files.length >= keepFiles) {
    const oldest = files.shift();
    if (oldest === undefined) break;
    try {
      unlinkSync(join(directory, oldest));
    } catch {}
  }
}

function openUniqueFile(
  directory: string,
  stamp: string,
  pid: number,
): { fd: number; path: string } {
  for (let suffix = 0; suffix < 100; suffix++) {
    const discriminator = suffix === 0 ? "" : `-${suffix}`;
    const path = join(directory, `${FILE_PREFIX}${stamp}-${pid}${discriminator}${FILE_SUFFIX}`);
    try {
      return { fd: openSync(path, "wx", 0o600), path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("could not allocate a unique Clarvis diagnostic log");
}

/**
 * Project a logged bindings object into a record's `context`.
 *
 * @param value - the first argument of a `pino`-shaped log call.
 * @returns the projected context, or `undefined` when there is nothing to say.
 * @remarks This used to iterate a hand-maintained 47-entry **allowlist** of
 * field names, which meant it iterated the allowlist rather than the object: a
 * field nobody had thought to add was dropped on arrival, silently, in the only
 * diagnostic surface this host has. `tool`, `path`, `agent`, `iteration`,
 * `event`, `run_id`, `session_id` and `owner` were all absent, so the engine's
 * own log lines reached a user's debug file stripped of the data identifying
 * them. It is now a denylist: {@link sanitize} withholds a value by key
 * classification and bounds everything it keeps, so an unforeseen field is
 * carried rather than lost.
 *
 * Keys are normalized to snake_case on the way out, so one record's vocabulary
 * does not depend on which side of the kernel boundary wrote it.
 */
function loggerContext(value: unknown): DiagnosticDetails | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const projected = sanitize(value);
  if (projected === null || typeof projected !== "object" || Array.isArray(projected)) {
    return undefined;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(projected)) {
    if (item === undefined) continue;
    output[classifiedKey(key)] = item;
  }
  return Object.keys(output).length === 0 ? undefined : output;
}

/**
 * The stable event name a logged bindings object declares, if it declares one.
 *
 * @param args - the arguments of a `pino`-shaped log call.
 * @param level - the level, used to build the fallback name.
 * @returns the record's event name.
 * @remarks Without this every line crossing the kernel boundary was recorded as
 * `kernel.debug|info|warn|error`, so four names covered the whole engine and the
 * free-text message was the only thing distinguishing one failure from another.
 * A record could not be selected by event class at all.
 */
function loggerEvent(args: unknown[], level: DiagnosticLevel): string {
  const first = args[0];
  if (first !== null && typeof first === "object") {
    const descriptor = Object.getOwnPropertyDescriptor(first, "event");
    const declared =
      descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    if (typeof declared === "string" && validDiagnosticName(declared)) return declared;
  }
  return `kernel.${level}`;
}

function loggerDetails(args: unknown[], bound?: DiagnosticDetails): DiagnosticDetails {
  if (typeof args[0] === "string")
    return {
      ...(bound === undefined ? {} : { context: bound }),
      message: args[0],
    };
  const declared = loggerContext(args[0]);
  const context =
    bound === undefined ? declared : { ...bound, ...(declared === undefined ? {} : declared) };
  return {
    ...(context === undefined ? {} : { context }),
    ...(typeof args[1] === "string" ? { message: args[1] } : {}),
  };
}

/**
 * Open one bounded, owner-only JSONL diagnostic session for an interactive TUI process.
 *
 * Counter events are deliberately sampled at the first eight calls and powers of two. A runaway
 * loop therefore remains visible without the diagnostic mechanism becoming the memory or disk leak.
 */
export function createDiagnosticSession(options: DiagnosticSessionOptions = {}): DiagnosticSession {
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const requestedMaxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxBytes =
    Number.isFinite(requestedMaxBytes) && requestedMaxBytes > 0
      ? Math.max(FINAL_RESERVE_BYTES, Math.floor(requestedMaxBytes))
      : DEFAULT_MAX_BYTES;
  const finalReserve = Math.min(FINAL_RESERVE_BYTES, Math.floor(maxBytes / 4));
  const regularLimit = maxBytes - finalReserve;
  const requestedKeepFiles = options.keepFiles ?? DEFAULT_KEEP_FILES;
  const keepFiles =
    Number.isFinite(requestedKeepFiles) && requestedKeepFiles > 0
      ? Math.max(1, Math.floor(requestedKeepFiles))
      : DEFAULT_KEEP_FILES;
  if (options.directory === undefined) ensureWorkspaceLocalDir(options.workspace);
  const directory = options.directory ?? workspaceStatePaths(options.workspace).diagnosticsDir;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  retainNewest(directory, keepFiles);
  const stamp = new Date(now()).toISOString().replaceAll(":", "-");
  const opened = openUniqueFile(directory, stamp, pid);
  let level = options.level ?? DEFAULT_DIAGNOSTIC_LEVEL;
  let floor = levelRank(level);
  let bytes = 0;
  let sequence = 0;
  let closed = false;
  let saturated = false;
  const counters = new Map<string, number>();
  const bindings: Record<string, unknown> = {};
  const heartbeat: { timer?: ReturnType<typeof setInterval> } = {};

  /**
   * Whether this record still carries `memory`.
   *
   * @param recordLevel - the record's own level.
   * @returns `true` for anything at `warn` or above, and for the first record
   *   and every {@link MEMORY_SAMPLE_EVERY}-th one after it otherwise.
   */
  const samplesMemory = (recordLevel: DiagnosticLevel): boolean =>
    levelRank(recordLevel) >= levelRank("warn") || (sequence - 1) % MEMORY_SAMPLE_EVERY === 0;

  const buildLine = (
    source: "code" | "kernel",
    recordLevel: DiagnosticLevel,
    event: string,
    details: DiagnosticDetails = {},
  ): string => {
    const record = {
      v: FORMAT_VERSION,
      at: new Date(now()).toISOString(),
      seq: ++sequence,
      level: recordLevel,
      source,
      event: eventName(event),
      pid,
      ...bindings,
      ...(samplesMemory(recordLevel) ? { memory: process.memoryUsage() } : {}),
      details: sanitize(details),
    };
    let line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
      line = `${JSON.stringify({
        ...record,
        details: { truncated: true, reason: "record exceeded 16 KiB" },
      })}\n`;
    }
    return line;
  };

  const append = (line: string): boolean => {
    const lineBytes = Buffer.byteLength(line);
    if (bytes + lineBytes > maxBytes) return false;
    try {
      writeSync(opened.fd, line);
      bytes += lineBytes;
      return true;
    } catch {
      saturated = true;
      return false;
    }
  };

  /**
   * Append one record, unless it is below the session's level.
   *
   * @param force - reserved for the session's own lifecycle records, which
   *   bypass both the level floor and saturation: `diagnostics.start` names the
   *   file being written and `diagnostics.stop` carries the counter summary, so
   *   `--debug=error` must not reduce the log to an empty file.
   */
  const write = (
    source: "code" | "kernel",
    recordLevel: DiagnosticLevel,
    event: string,
    details: DiagnosticDetails = {},
    force = false,
  ): void => {
    if (closed || (saturated && !force)) return;
    if (!force && levelRank(recordLevel) < floor) return;
    const line = buildLine(source, recordLevel, event, details);
    if (!force && bytes + Buffer.byteLength(line) > regularLimit) {
      saturated = true;
      append(
        buildLine("code", "warn", "diagnostics.saturated", {
          bytes,
          maxBytes,
          regularLimit,
        }),
      );
      return;
    }
    append(line);
  };

  /**
   * Read a requested child level as a rank the child's own filter compares to.
   *
   * @param requested - a `LogLevel` from `CLARVIS_LOG`, which is a wider
   *   vocabulary than a record's: it also admits `silent`.
   * @returns the floor; `0` (emit everything) when absent or unrecognized, and
   *   one past `error` for `silent`, so nothing that component writes survives.
   * @remarks An unrecognized level emits rather than suppresses, because a
   *   diagnostic lost to an unparsable level is worse than one written
   *   needlessly — the same rule `levelEnabled` applies on the contract side.
   */
  const childFloor = (requested: string | undefined): number => {
    if (requested === undefined) return 0;
    if (requested === "silent") return DIAGNOSTIC_LEVELS.length;
    const rank = DIAGNOSTIC_LEVELS.indexOf(requested as DiagnosticLevel);
    return rank === -1 ? 0 : rank;
  };

  /**
   * Build a logger writing through this session, optionally scoped.
   *
   * @param bound - already-sanitized bindings merged into every record's
   *   `context`; this is how the kernel's `component` reaches the JSONL.
   * @param ownFloor - the derived logger's own floor, composed with the
   *   session's by {@link write} applying its own on top.
   */
  const makeLogger = (bound: DiagnosticDetails | undefined, ownFloor: number): DiagnosticLogger => {
    const derived = {
      child: (bindings: Record<string, unknown>, options?: { level?: string }) =>
        makeLogger(
          { ...bound, ...loggerContext(bindings) },
          Math.max(ownFloor, childFloor(options?.level)),
        ),
      level: DIAGNOSTIC_LEVELS[Math.max(floor, ownFloor)] ?? "silent",
    } as DiagnosticLogger;
    for (const each of DIAGNOSTIC_LEVELS) {
      derived[each] = (...args: unknown[]) => {
        if (levelRank(each) < ownFloor) return;
        write("kernel", each, loggerEvent(args, each), loggerDetails(args, bound));
      };
    }
    return derived;
  };

  const logger = makeLogger(undefined, 0);

  /**
   * Merge `fields` into the envelope stamped onto every later record.
   *
   * @remarks Sanitized once here rather than per record, and refused for the
   * envelope's own keys so a binding cannot rewrite `seq`, `level` or `event`
   * out from under a reader.
   */
  const bind = (fields: DiagnosticDetails): void => {
    for (const [key, value] of Object.entries(fields)) {
      const name = classifiedKey(key);
      if (RESERVED_ENVELOPE_KEYS.has(name)) continue;
      if (value === undefined) delete bindings[name];
      else bindings[name] = mustRedactKey(name) ? REDACTED : sanitize(value);
    }
  };

  const session: DiagnosticSession = {
    path: opened.path,
    logger,
    get level() {
      return level;
    },
    setLevel: (next) => {
      if (next === level) return;
      const from = level;
      level = next;
      floor = levelRank(next);
      write("code", "info", "diagnostics.level", { from, to: next }, true);
    },
    bind,
    event: (event, details, recordLevel = "debug") => write("code", recordLevel, event, details),
    count: (event, details = {}, counterKey = event) => {
      const normalizedCounterKey = counterName(counterKey);
      const key =
        counters.has(normalizedCounterKey) || counters.size < MAX_COUNTERS
          ? normalizedCounterKey
          : "diagnostics.counter-overflow";
      const count = (counters.get(key) ?? 0) + 1;
      counters.set(key, count);
      if (count <= 8 || isPowerOfTwo(count)) write("code", "debug", event, { ...details, count });
    },
    close: () => {
      if (closed) return;
      const topCounters = [...counters]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 32)
        .map(([name, count]) => ({ name, count }));
      write(
        "code",
        "info",
        "diagnostics.stop",
        {
          bytes,
          saturated,
          counterKeys: counters.size,
          topCounters,
        },
        true,
      );
      closed = true;
      if (heartbeat.timer !== undefined) clearInterval(heartbeat.timer);
      try {
        closeSync(opened.fd);
      } catch {}
    },
  };
  write(
    "code",
    "info",
    "diagnostics.start",
    { path: opened.path, maxBytes, keepFiles, level },
    true,
  );
  let heartbeatExpectedAt = now() + HEARTBEAT_MS;
  heartbeat.timer = setInterval(() => {
    const sampledAt = now();
    session.event("runtime.heartbeat", {
      delayedMs: Math.max(0, sampledAt - heartbeatExpectedAt),
    });
    heartbeatExpectedAt = sampledAt + HEARTBEAT_MS;
  }, HEARTBEAT_MS);
  heartbeat.timer.unref();
  return session;
}
