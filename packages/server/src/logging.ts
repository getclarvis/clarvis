import { NOOP_LOGGER, bind, type Logger } from "@clarvis/capability";
import type { OwnerMode } from "./config/owner.ts";

/**
 * The two channels every server collaborator writes through.
 *
 * @remarks They are carried as one value rather than two parameters because the
 * bindings that make a record readable — the request, the session, the run —
 * belong on **both**. An audit line naming a session that cannot say which
 * client opened it is as useless as a diagnostic one, and threading two loggers
 * through nine signatures is how one of them silently stops being bound.
 *
 * `audit` is level-pinned by its factory (`createAuditLogger`) and shares
 * `log`'s destination; see `specs/cross-cutting/observability.md` §4.3.
 */
export interface ServerLoggers {
  /** Diagnostics: everything an operator debugging Clarvis reads. */
  readonly log: Logger;
  /** Authentication and authorization decisions, which survive the level filter. */
  readonly audit: Logger;
  /**
   * Derive both channels with `bindings` stamped on every record.
   *
   * @param bindings - fields the derived pair adds to its own.
   * @returns the derived pair.
   */
  child(bindings: Record<string, unknown>): ServerLoggers;
}

/**
 * Pair a diagnostic channel with an audit channel.
 *
 * @param log - the diagnostic logger.
 * @param audit - the level-pinned audit logger over the same destination.
 * @returns the {@link ServerLoggers} pair.
 */
export function createServerLoggers(log: Logger, audit: Logger): ServerLoggers {
  return {
    log,
    audit,
    child(bindings: Record<string, unknown>): ServerLoggers {
      return createServerLoggers(bind(log, bindings), bind(audit, bindings));
    },
  };
}

/**
 * The pair a collaborator constructed without one falls back to.
 *
 * @remarks Options-bag properties cannot carry a default, so each is normalized
 * to this exactly once at construction and every site below that point calls it
 * unconditionally — see `specs/cross-cutting/observability.md` §2.8.
 */
export const SILENT_SERVER_LOGGERS: ServerLoggers = createServerLoggers(NOOP_LOGGER, NOOP_LOGGER);

/**
 * The two fields an owner is *always* logged as.
 *
 * @param owner - the resolved owner id.
 * @param mode - the configured owner mode.
 * @returns `owner` plus whether that id was authenticated.
 * @remarks Only `token` mode derives the owner from an authenticated enrolment
 *   record. Under `fixed`, `header` and `allowlist` it is caller-supplied, so a
 *   line reading `owner: "acme"` on its own asserts a boundary that does not
 *   exist. Deriving the pair in one place is what keeps the marker from being
 *   forgotten at the fifth call site.
 */
export function ownerFields(
  owner: string,
  mode: OwnerMode,
): { owner: string; owner_authenticated: boolean } {
  return { owner, owner_authenticated: mode === "token" };
}

/** How much of the per-request hot path reaches the log. */
export type RequestLogMode = "off" | "errors" | "all";

/** One completed HTTP exchange, as `http.request` reports it. */
export interface RequestLogFields {
  method: string;
  path: string;
  status: number;
  dur_ms: number;
  req_bytes: number;
  session_id?: string | undefined;
  owner?: string | undefined;
  owner_authenticated?: boolean | undefined;
  client_id?: string | undefined;
  rpc_method?: string | undefined;
}

/**
 * Record one HTTP exchange, if the configured mode admits it.
 *
 * @param logger - the request-bound diagnostic logger, already carrying `req_id`.
 * @param mode - the resolved `CLARVIS_SERVER_LOG_REQUESTS`.
 * @param fields - see {@link RequestLogFields}.
 * @remarks Opt-in because this is the one genuinely hot site in the package: a
 *   busy facade answers far more requests than it runs runs. It is written at
 *   response-headers time and never awaits the body — a Streamable HTTP response
 *   is a live stream, so a `finally` that waited for it would report the *run's*
 *   duration up to half an hour late.
 */
export function logHttpRequest(
  logger: Logger,
  mode: RequestLogMode,
  fields: RequestLogFields,
): void {
  if (mode === "off") return;
  if (mode === "errors" && fields.status < 400) return;
  logger.info(
    { event: "http.request", ...fields },
    "an HTTP request was answered; the status is what the caller saw",
  );
}

/** The response header naming the log line a client-visible failure came from. */
export const REQUEST_ID_HEADER = "x-clarvis-request-id";

/**
 * Mint an opaque correlation id.
 *
 * @returns twelve hex digits, the house length for an opaque id.
 * @remarks Twelve rather than the whole UUID because the redaction rules
 *   withhold an unbroken high-entropy run, and withholding the field that says
 *   *which* request a line is about defeats the point of having one.
 *
 *   Twelve rather than any other short length because the id has to survive
 *   being read aloud from a response header and grepped for in a log: 48 bits is
 *   already past collision within any window a log covers, while the length
 *   stays scannable in a column of them. It is a *correlation* id and never an
 *   authorization token, so its entropy has no security requirement to meet —
 *   the `jti` on an issued token is a full UUID for exactly that reason.
 */
function shortId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

/**
 * Mint the id one request is logged under.
 *
 * @returns a {@link shortId}.
 * @remarks Never derived from a caller-supplied header: an id a caller chooses
 *   is an id a caller can collide with, and correlation that can be poisoned is
 *   worse than none. A caller's own id, if it is ever carried, is a separate
 *   `client_req_id` field.
 */
export function newRequestId(): string {
  return shortId();
}

/**
 * Mint the id this process is logged under, stamped on every record it writes.
 *
 * @returns a {@link shortId}.
 * @remarks One replica per config directory is the deployment shape, but several
 *   replicas may still share a log aggregator, and a restart is a new instance.
 */
export function newInstanceId(): string {
  return shortId();
}
