import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import { SignJWT } from "jose";
import type { AuthConfigSource } from "./auth-config.ts";
import type { SigningKey } from "./keys.ts";
import { UNMATCHABLE_SECRET_HASH, verifyClientSecret } from "./secrets.ts";

/**
 * The error codes this endpoint answers with.
 *
 * @remarks Not a transcription of one list. RFC 6749 §5.2 defines six codes and
 * four of them are here; the two missing are the ones supporting exactly one
 * grant type makes unreachable. The remaining three come from elsewhere —
 * `invalid_target` from RFC 8707, `slow_down` from RFC 8628, and
 * `temporarily_unavailable` from RFC 6749's *authorization*-endpoint errors
 * (§4.1.2.1) rather than its token-endpoint ones.
 *
 * The two omissions are structural rather than unfinished work. §5.2's
 * `invalid_grant` describes an authorization code, refresh token or
 * resource-owner credential that failed to validate, and `client_credentials`
 * has no such artifact — the secret *is* the client authentication, and its
 * failure is `invalid_client`. §5.2's `unauthorized_client` describes an
 * authenticated client barred from a grant type, which cannot arise either: a
 * request naming any other grant type is refused `unsupported_grant_type`
 * before client authentication is attempted at all, and every enrolled client
 * may use the one grant type there is. Adding a second grant type is what would
 * bring them back, and it would bring back the branches that construct them.
 */
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_scope"
  | "invalid_target"
  | "unsupported_grant_type"
  | "slow_down"
  | "temporarily_unavailable";

/** A token-endpoint failure, carrying the HTTP status it must be reported with. */
export class OAuthError extends Error {
  readonly error: OAuthErrorCode;
  readonly status: number;
  /** Seconds to advertise in `Retry-After`, when the failure is a throttle. */
  readonly retryAfterS: number | undefined;

  constructor(error: OAuthErrorCode, description: string, status = 400, retryAfterS?: number) {
    super(description);
    this.name = "OAuthError";
    this.error = error;
    this.status = status;
    this.retryAfterS = retryAfterS;
  }
}

/** Longest `client_id` the token endpoint will even hash, let alone remember. */
const MAX_CLIENT_ID_LENGTH = 128;

/** A successful `client_credentials` exchange. */
export interface TokenGrant {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
}

/** The credentials and constraints one token request carries. */
export interface TokenRequest {
  readonly grantType: string;
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  /** RFC 8707 `resource`, when the client names the audience it wants. */
  readonly resource?: string | undefined;
  readonly scope?: string | undefined;
  /** Peer address, so one host cannot spend every client's attempt budget. */
  readonly peer?: string | undefined;
}

/** Issues access tokens for enrolled clients. */
export interface TokenIssuer {
  /**
   * Exchange client credentials for an access token.
   *
   * @throws {@link OAuthError} for every rejection, including a wrong secret.
   */
  issue(request: TokenRequest): Promise<TokenGrant>;
}

/** A fixed-window attempt budget. */
export interface AttemptLimiter {
  /** @returns `false` when the key has spent its budget for the current window. */
  take(key: string): boolean;
  /** @returns whether the key has budget left, without spending any. */
  peek(key: string): boolean;
}

/**
 * Build a fixed-window {@link AttemptLimiter}.
 *
 * @param opts - the budget, window length and the key ceiling.
 * @returns the limiter; its bookkeeping is per process, which is the same scope
 *   as everything else here (one replica per config directory).
 * @remarks Keys are attacker-chosen, so the table is bounded twice over: expired
 *   windows are dropped first, and if that is not enough the oldest surviving
 *   entries are evicted. Dropping only the expired ones would leave a flood of
 *   distinct ids growing the map without limit while every insert paid a full
 *   scan — quadratic work an unauthenticated caller could choose. Every window
 *   is the same length, so insertion order is expiry order and eviction from the
 *   front is eviction of the oldest.
 */
export function createAttemptLimiter(opts: {
  max: number;
  windowMs: number;
  maxKeys?: number;
}): AttemptLimiter {
  const maxKeys = opts.maxKeys ?? 4_096;
  const windows = new Map<string, { count: number; resetAt: number }>();

  const prune = (now: number): void => {
    for (const [name, window] of windows) if (now >= window.resetAt) windows.delete(name);
    let excess = windows.size - maxKeys;
    if (excess <= 0) return;
    for (const name of windows.keys()) {
      windows.delete(name);
      if (--excess <= 0) return;
    }
  };

  return {
    take(key): boolean {
      const now = Date.now();
      const current = windows.get(key);
      if (current === undefined || now >= current.resetAt) {
        windows.set(key, { count: 1, resetAt: now + opts.windowMs });
        if (windows.size > maxKeys) prune(now);
        return true;
      }
      if (current.count >= opts.max) return false;
      current.count += 1;
      return true;
    },
    peek(key): boolean {
      const current = windows.get(key);
      if (current === undefined || Date.now() >= current.resetAt) return true;
      return current.count < opts.max;
    },
  };
}

/** Options for {@link createTokenIssuer}. */
export interface TokenIssuerOptions {
  config: AuthConfigSource;
  key: SigningKey;
  /**
   * Failed attempts allowed per `(client_id, peer)` pair in each window.
   *
   * @remarks Keyed on the **pair**, not on the client id, so nobody can spend a
   * budget that is not theirs. Keyed on the id alone, anyone who learned a
   * `client_id` — it is a token `sub`, not a secret — could throttle the real
   * client by presenting wrong secrets from anywhere.
   */
  limiter?: AttemptLimiter;
  /**
   * Failed attempts allowed per peer address in each window.
   *
   * @remarks Deliberately far more generous than the per-pair budget. A peer is
   * not an identity: a whole fleet can share one egress address, so a budget
   * sized for a single client would let one misconfigured caller with a stale
   * secret lock out every unrelated client behind the same NAT.
   */
  peerLimiter?: AttemptLimiter;
  /** Window length backing the default limiters and the `Retry-After` they advertise. */
  attemptWindowMs?: number;
  /**
   * Where every exchange, refusal and throttle is recorded.
   *
   * @remarks The audit channel: who obtained a credential is not a diagnostic,
   * and `CLARVIS_LOG_LEVEL=warn` must not silence a successful issuance.
   */
  audit?: Logger;
}

/** The address a token request came from, as a field value. */
function peerOf(request: TokenRequest): string {
  return request.peer ?? "unknown";
}

/**
 * Record one refused exchange.
 *
 * @param audit - the audit channel.
 * @param request - the token request, read only for its peer.
 * @param error - the refusal, carrying its own code and status.
 * @param clientId - the presented id, when this server got as far as parsing one.
 * @returns `error`, so a caller writes `throw reportRejected(...)`.
 * @remarks The presented secret and the digest it was compared against are both
 * in scope where this is called, and neither is a field. Nor is the error
 * object: it may close over either.
 */
function reportRejected(
  audit: Logger,
  request: TokenRequest,
  error: OAuthError,
  clientId?: string,
): OAuthError {
  audit.warn(
    {
      event: "auth.token.rejected",
      ...(clientId !== undefined ? { client_id: clientId } : {}),
      reason: error.error,
      peer: peerOf(request),
      status: error.status,
    },
    "a token request was refused; no credential was issued for it",
  );
  return error;
}

/** Record one exchange refused by an attempt budget rather than by a credential. */
function reportThrottled(
  audit: Logger,
  request: TokenRequest,
  clientId: string,
  retryAfterS: number,
  budget: "client" | "peer",
): void {
  audit.warn(
    {
      event: "auth.token.throttled",
      client_id: clientId,
      peer: peerOf(request),
      retry_after_s: retryAfterS,
      budget,
    },
    "a token request spent its failure budget; it is answered slow_down rather than invalid_client, so the diagnosis is not misdirected to a wrong secret",
  );
}

/** Record one successful exchange. */
function reportIssued(
  audit: Logger,
  request: TokenRequest,
  clientId: string,
  expiresIn: number,
): void {
  audit.info(
    {
      event: "auth.token.issued",
      client_id: clientId,
      expires_in: expiresIn,
      peer: peerOf(request),
    },
    "an access token was issued; its owner and role are still resolved from auth.json on every request",
  );
}

/**
 * Build the `client_credentials` {@link TokenIssuer}.
 *
 * @param opts - config source, signing key and the abuse bounds.
 * @returns the issuer.
 * @remarks **Verification is a fast digest comparison, and that is the whole
 *   defence.** A password KDF here would make every attempt expensive enough to
 *   be a memory-amplification vector on an unauthenticated endpoint, which then
 *   needs an attempt budget to contain, which in turn hands anyone who learns a
 *   `client_id` a way to throttle the real client. See
 *   {@link hashClientSecret} for why the KDF bought nothing against a
 *   256-bit secret in the first place.
 *
 *   The budgets that remain are **failure** budgets, checked before the work and
 *   charged only on a wrong credential, so successful traffic never throttles
 *   anyone. The per-client one is keyed on `(client_id, peer)`, so a caller can
 *   only ever spend its own; the peer one is a coarse flood backstop, sized far
 *   larger because an egress address may front a whole fleet.
 *
 *   Every credential rejection reports `invalid_client`. Distinguishing "no such
 *   client" from "wrong secret" would enumerate the enrolment table, which is
 *   also why an unknown id is still compared — against
 *   {@link UNMATCHABLE_SECRET_HASH} — rather than short-circuited.
 */
export function createTokenIssuer(opts: TokenIssuerOptions): TokenIssuer {
  /**
   * The two attempt budgets and the window they are counted in.
   *
   * @remarks They count only *failed* attempts, so a working client never
   * approaches either and the numbers are set entirely against what an attacker
   * gains. A client secret is high-entropy, so throttling is not what makes
   * guessing infeasible; the budgets exist to make an online attack pointlessly
   * slow and to put a bound on the audit volume one caller can generate.
   *
   * The tenfold gap is the load-bearing part, not either figure. The per-pair
   * budget is sized for a human or a config error — a handful of wrong secrets
   * before someone notices — while the peer budget has to hold a whole fleet
   * behind one NAT, so it is set where a single misconfigured caller cannot
   * exhaust it before its own pair budget stops it first.
   *
   * A minute is the window because it is also what the `Retry-After` advertises;
   * shorter makes the throttle ineffective against a patient attacker, longer
   * turns a transient misconfiguration into an outage.
   */
  const windowMs = opts.attemptWindowMs ?? 60_000;
  const windowS = Math.ceil(windowMs / 1_000);
  const limiter = opts.limiter ?? createAttemptLimiter({ max: 10, windowMs });
  const peerLimiter = opts.peerLimiter ?? createAttemptLimiter({ max: 100, windowMs });
  const audit = opts.audit ?? NOOP_LOGGER;

  const invalidClient = (): OAuthError =>
    new OAuthError("invalid_client", "client authentication failed", 401);

  const throttled = (retryAfterS: number): OAuthError =>
    new OAuthError(
      "slow_down",
      "too many failed authentication attempts; retry after the window closes",
      429,
      retryAfterS,
    );

  return {
    async issue(request): Promise<TokenGrant> {
      if (request.grantType !== "client_credentials") {
        throw reportRejected(
          audit,
          request,
          new OAuthError(
            "unsupported_grant_type",
            "this server supports only grant_type=client_credentials",
          ),
          request.clientId,
        );
      }
      if (request.scope !== undefined && request.scope.trim().length > 0) {
        throw reportRejected(
          audit,
          request,
          new OAuthError("invalid_scope", "this server issues no scopes"),
          request.clientId,
        );
      }
      const clientId = request.clientId;
      const clientSecret = request.clientSecret;
      if (
        clientId === undefined ||
        clientId.length === 0 ||
        clientSecret === undefined ||
        clientSecret.length === 0
      ) {
        throw reportRejected(
          audit,
          request,
          new OAuthError("invalid_client", "client_id and client_secret are required", 401),
        );
      }

      const config = opts.config.current();
      if (
        request.resource !== undefined &&
        request.resource.length > 0 &&
        request.resource !== config.resource
      ) {
        throw reportRejected(
          audit,
          request,
          new OAuthError("invalid_target", "unknown resource"),
          clientId,
        );
      }

      if (clientId.length > MAX_CLIENT_ID_LENGTH) {
        throw reportRejected(audit, request, invalidClient());
      }

      const budgets: { limiter: AttemptLimiter; key: string; name: "client" | "peer" }[] = [
        { limiter, key: `client:${clientId}|peer:${request.peer ?? "unknown"}`, name: "client" },
      ];
      if (request.peer !== undefined) {
        budgets.push({ limiter: peerLimiter, key: `peer:${request.peer}`, name: "peer" });
      }
      const exhausted = budgets.find((budget) => !budget.limiter.peek(budget.key));
      if (exhausted !== undefined) {
        reportThrottled(audit, request, clientId, windowS, exhausted.name);
        throw throttled(windowS);
      }

      const client = config.clients.find((candidate) => candidate.clientId === clientId);
      const matched = verifyClientSecret(
        clientSecret,
        client?.secretHash ?? UNMATCHABLE_SECRET_HASH,
      );
      if (!matched || client === undefined || client.disabled) {
        for (const budget of budgets) budget.limiter.take(budget.key);
        throw reportRejected(audit, request, invalidClient(), clientId);
      }

      const token = await new SignJWT({})
        .setProtectedHeader({ alg: opts.key.alg, kid: opts.key.kid, typ: "at+jwt" })
        .setIssuer(config.issuer)
        .setAudience(config.resource)
        .setSubject(client.clientId)
        .setIssuedAt()
        .setExpirationTime(`${config.tokenTtlS}s`)
        .setJti(crypto.randomUUID())
        .sign(opts.key.privateKey);

      reportIssued(audit, request, client.clientId, config.tokenTtlS);
      return { access_token: token, token_type: "Bearer", expires_in: config.tokenTtlS };
    },
  };
}
