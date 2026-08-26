import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ElicitRequestSchema,
  LoggingMessageNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  buildMcpServer,
  type McpServerBundle,
  type McpServerLimits,
} from "../../src/mcp/server.ts";
import { fixedKernelResolver, type RunHost } from "../../src/host/run-host.ts";
import type { Principal } from "../../src/auth/principals.ts";
import { NOOP_LOGGER, type LogFn, type Logger } from "@clarvis/capability";
import {
  createServerLoggers,
  SILENT_SERVER_LOGGERS,
  type ServerLoggers,
} from "../../src/logging.ts";

/**
 * The pair every harness passes where a host would pass its real one.
 *
 * @remarks Shared rather than constructed per test, and silent rather than real:
 * threading a live logger through the suite is how test output stops being
 * readable.
 */
export const SILENT_LOGGERS: ServerLoggers = SILENT_SERVER_LOGGERS;

/** One record a {@link recordingLoggers} pair captured. */
export interface LogRecord {
  channel: "log" | "audit";
  level: "debug" | "info" | "warn" | "error";
  fields: Record<string, unknown>;
  message: string | undefined;
}

/** A capturing logger, built from {@link NOOP_LOGGER} so an unimplemented level cannot throw. */
function capturingLogger(
  channel: "log" | "audit",
  records: LogRecord[],
  bindings: Record<string, unknown>,
): Logger {
  const write = (level: LogRecord["level"]): LogFn =>
    ((obj: unknown, message?: unknown): void => {
      const fields =
        typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>) : {};
      const text =
        typeof obj === "string" ? obj : typeof message === "string" ? message : undefined;
      records.push({ channel, level, fields: { ...bindings, ...fields }, message: text });
    }) as LogFn;
  return {
    ...NOOP_LOGGER,
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child: (extra) => capturingLogger(channel, records, { ...bindings, ...extra }),
  };
}

/** A {@link ServerLoggers} pair that records instead of writing. */
export interface RecordingLoggers {
  loggers: ServerLoggers;
  records: LogRecord[];
  /** Every record whose `event` field matches. */
  find(event: string): LogRecord[];
  /** The single record with that `event`; throws when there is not exactly one. */
  one(event: string): LogRecord;
}

/** Build a {@link RecordingLoggers}. */
export function recordingLoggers(): RecordingLoggers {
  const records: LogRecord[] = [];
  const loggers = createServerLoggers(
    capturingLogger("log", records, {}),
    capturingLogger("audit", records, {}),
  );
  const find = (event: string): LogRecord[] =>
    records.filter((record) => record.fields.event === event);
  return {
    loggers,
    records,
    find,
    one(event: string): LogRecord {
      const matches = find(event);
      if (matches.length !== 1) {
        throw new Error(
          `expected exactly one '${event}' record, saw ${String(matches.length)}: ` +
            records.map((record) => String(record.fields.event)).join(", "),
        );
      }
      return matches[0] as LogRecord;
    },
  };
}

/** Limits small enough that tests exercise the caps without waiting on them. */
const TEST_LIMITS: McpServerLimits = {
  maxRuns: 8,
  maxRunsPerOwner: 4,
  bufferMax: 64,
  bufferMaxBytes: 1024 * 1024,
  sendTimeoutMs: 5_000,
  heartbeatMs: 60_000,
  runMaxMs: 30_000,
  settleGraceMs: 2_000,
  elicitToolWaitMs: 30_000,
  elicitRelayMs: 5_000,
  allowRemoteGuardApproval: false,
};

/** A connected client/server pair over an in-memory transport. */
export interface Harness {
  client: Client;
  bundle: McpServerBundle;
  /** Everything the client received on `notifications/message`. */
  messages: { level: string; logger?: string; data: unknown }[];
  /** Deterministic notification barrier for an in-flight tool call. */
  waitForMessage(
    predicate: (message: { level: string; logger?: string; data: unknown }) => boolean,
  ): Promise<{ level: string; logger?: string; data: unknown }>;
  close(): Promise<void>;
}

const openHarnesses = new Set<Harness>();

/** Close every harness a test opened, including one abandoned by a failed assertion. */
export async function closeOpenHarnesses(): Promise<void> {
  await Promise.allSettled([...openHarnesses].map((harness) => harness.close()));
}

/** Options for {@link makeHarness}. */
export interface HarnessOptions {
  host: RunHost;
  owner?: string;
  limits?: Partial<McpServerLimits>;
  /** The authenticated caller whose role the tools must enforce. */
  principal?: Principal;
  /** Captures what the session and its runs log; silent by default. */
  loggers?: ServerLoggers;
  /** Declares MCP's `elicitation` capability and answers with this. */
  onElicit?: (params: { message: string }) => Promise<{
    action: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
  }>;
}

/**
 * Wire an SDK client to the facade over a linked in-memory transport pair.
 *
 * @param opts - the host, owner and whether the client declares elicitation.
 * @returns the connected pair plus a notification log.
 */
export async function makeHarness(opts: HarnessOptions): Promise<Harness> {
  const resolved = await fixedKernelResolver(
    opts.host,
    opts.owner ?? "default",
  )({
    sessionId: undefined,
    owner: opts.owner ?? "default",
    headers: new Headers(),
  });

  const bundle = buildMcpServer({
    resolved,
    limits: { ...TEST_LIMITS, ...opts.limits },
    logger: opts.loggers ?? SILENT_LOGGERS,
    ...(opts.principal !== undefined ? { getPrincipal: () => opts.principal } : {}),
  });

  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: opts.onElicit !== undefined ? { elicitation: {} } : {} },
  );
  if (opts.onElicit !== undefined) {
    const answer = opts.onElicit;
    client.setRequestHandler(ElicitRequestSchema, (request) =>
      answer({ message: request.params.message }),
    );
  }

  const messages: { level: string; logger?: string; data: unknown }[] = [];
  const messageWaiters: Array<{
    predicate: (message: (typeof messages)[number]) => boolean;
    resolve: (message: (typeof messages)[number]) => void;
    reject: (error: Error) => void;
  }> = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    const message = notification.params as (typeof messages)[number];
    messages.push(message);
    for (let index = messageWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = messageWaiters[index];
      if (waiter?.predicate(message) === true) {
        messageWaiters.splice(index, 1);
        waiter.resolve(message);
      }
    }
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([bundle.server.connect(serverTransport), client.connect(clientTransport)]);
  } catch (error) {
    await client.close().catch(() => undefined);
    await bundle.server.close().catch(() => undefined);
    throw error;
  }

  let closed = false;
  const harness: Harness = {
    client,
    bundle,
    messages,
    waitForMessage(predicate) {
      const existing = messages.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        messageWaiters.push({ predicate, resolve, reject });
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      openHarnesses.delete(harness);
      for (const waiter of messageWaiters.splice(0)) {
        waiter.reject(new Error("harness closed before the notification arrived"));
      }
      bundle.cancelAll("session_close");
      await client.close().catch(() => undefined);
      await bundle.server.close().catch(() => undefined);
      const fake = opts.host as RunHost & { settled?: () => Promise<void> };
      await fake.settled?.();
    },
  };
  openHarnesses.add(harness);
  return harness;
}

/** Read a tool result's structured payload. */
export function payloadOf(result: unknown): Record<string, unknown> {
  const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
  if (structured !== undefined) return structured;
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  const text = content.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}
