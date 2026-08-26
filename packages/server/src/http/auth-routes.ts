import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type { AuthConfigSource } from "../auth/auth-config.ts";
import { OAuthError, type TokenIssuer } from "../auth/issuer.ts";
import { jwks, type SigningKey } from "../auth/keys.ts";
import { readBoundedBodyText } from "./guards.ts";

/** Where this server issues tokens. */
const TOKEN_PATH = "/oauth/token";
/** Where this server publishes the public half of its signing key. */
const JWKS_PATH = "/.well-known/jwks.json";
/** RFC 9728 protected resource metadata; also matched with a path suffix. */
const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
/** RFC 8414 authorization server metadata; also matched with a path suffix. */
const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";

/** Longest accepted token-request body: credentials, never payloads. */
const MAX_TOKEN_BODY_BYTES = 8_192;

/** A JSON response that no cache may keep, as RFC 6749 §5.1 requires of credentials. */
function noStoreJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache", ...headers },
  });
}

/**
 * Decode HTTP Basic client credentials.
 *
 * @param request - the token request.
 * @returns the client id and secret, or `undefined` when the header is absent or
 *   malformed.
 * @remarks RFC 6749 §2.3.1 form-encodes both halves before base64, so they are
 *   decoded again here; a secret containing `:`, `+` or a space is otherwise
 *   silently mangled into a wrong-secret rejection nobody can debug. The
 *   encoding is `application/x-www-form-urlencoded`, **not** plain percent
 *   encoding, so `+` means a space and `decodeURIComponent` alone would leave it
 *   standing.
 */
function basicCredentials(request: Request): { id: string; secret: string } | undefined {
  const header = request.headers.get("authorization");
  if (header === null || !/^Basic[ ]+/i.test(header.trim())) return undefined;
  const encoded = header.trim().replace(/^Basic[ ]+/i, "");
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const separator = decoded.indexOf(":");
  if (separator === -1) return undefined;
  const formDecode = (part: string): string => {
    try {
      return decodeURIComponent(part.replace(/\+/g, "%20"));
    } catch {
      return part;
    }
  };
  return {
    id: formDecode(decoded.slice(0, separator)),
    secret: formDecode(decoded.slice(separator + 1)),
  };
}

/** Render an {@link OAuthError} in the RFC 6749 §5.2 shape. */
function oauthErrorResponse(err: OAuthError): Response {
  return noStoreJson({ error: err.error, error_description: err.message }, err.status, {
    ...(err.status === 401 ? { "www-authenticate": 'Basic realm="clarvis"' } : {}),
    ...(err.retryAfterS !== undefined ? { "retry-after": String(err.retryAfterS) } : {}),
  });
}

/**
 * Record a token request the issuer never saw.
 *
 * @param audit - the audit channel.
 * @param reason - the RFC 6749 code the caller is answered with.
 * @param status - the HTTP status that carries it.
 * @param peer - the caller's address.
 * @remarks Every refusal *inside* the issuer already reports itself, so only the
 * envelope checks in front of it and the catch-all behind it are recorded here;
 * logging in both places would double every rejection.
 */
function reportRouteRefusal(
  audit: Logger,
  reason: "invalid_request" | "temporarily_unavailable",
  status: number,
  peer: string | undefined,
): void {
  audit.warn(
    {
      event: "auth.token.rejected",
      reason,
      peer: peer ?? "unknown",
      status,
    },
    "a token request was refused before any credential was compared; nothing was issued for it",
  );
}

/**
 * Handle `POST /oauth/token`.
 *
 * @param request - the token request.
 * @param issuer - the configured {@link TokenIssuer}.
 * @param peer - the caller's address, for the attempt budget.
 * @param audit - the audit channel.
 * @returns the grant, or an RFC 6749 error response.
 */
async function handleTokenRequest(
  request: Request,
  issuer: TokenIssuer,
  peer?: string,
  audit: Logger = NOOP_LOGGER,
): Promise<Response> {
  if (request.method !== "POST") {
    reportRouteRefusal(audit, "invalid_request", 405, peer);
    return noStoreJson(
      { error: "invalid_request", error_description: "the token endpoint accepts POST" },
      405,
      { allow: "POST" },
    );
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    reportRouteRefusal(audit, "invalid_request", 400, peer);
    return oauthErrorResponse(
      new OAuthError("invalid_request", "the token endpoint expects a form-encoded body"),
    );
  }
  const oversized = new OAuthError("invalid_request", "the token request is too large");
  const text = await readBoundedBodyText(request, MAX_TOKEN_BODY_BYTES);
  if (text === null) {
    reportRouteRefusal(audit, "invalid_request", oversized.status, peer);
    return oauthErrorResponse(oversized);
  }
  const form = new URLSearchParams(text);
  const basic = basicCredentials(request);

  try {
    const grant = await issuer.issue({
      grantType: form.get("grant_type") ?? "",
      clientId: basic?.id ?? form.get("client_id") ?? undefined,
      clientSecret: basic?.secret ?? form.get("client_secret") ?? undefined,
      resource: form.get("resource") ?? undefined,
      scope: form.get("scope") ?? undefined,
      peer,
    });
    return noStoreJson(grant);
  } catch (err) {
    if (err instanceof OAuthError) return oauthErrorResponse(err);
    return unavailable(audit, peer);
  }
}

/**
 * Answer a token request the issuer could not complete at all.
 *
 * @param audit - the audit channel.
 * @param peer - the caller's address.
 * @returns the `503` the caller receives.
 * @remarks Extracted from its `catch` so it carries a coverage counter of its
 * own; a body folded into the enclosing `try` is counted whether or not it ran.
 */
function unavailable(audit: Logger, peer: string | undefined): Response {
  reportRouteRefusal(audit, "temporarily_unavailable", 503, peer);
  return oauthErrorResponse(
    new OAuthError("temporarily_unavailable", "token issuance failed", 503),
  );
}

/** The RFC 9728 metadata document naming who may authorize access to this server. */
function protectedResourceMetadata(config: AuthConfigSource): Response {
  const current = config.current();
  return Response.json({
    resource: current.resource,
    authorization_servers: [current.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [],
  });
}

/**
 * The RFC 8414 metadata document for this server's own authorization server.
 *
 * @remarks It advertises **no `registration_endpoint`**, which is how a
 * conforming client discovers that enrolment is the operator's act rather than
 * failing against a registration attempt that will never be accepted.
 */
function authorizationServerMetadata(config: AuthConfigSource): Response {
  const current = config.current();
  const base = current.issuer.endsWith("/") ? current.issuer.slice(0, -1) : current.issuer;
  return Response.json({
    issuer: current.issuer,
    token_endpoint: `${base}${TOKEN_PATH}`,
    jwks_uri: `${base}${JWKS_PATH}`,
    grant_types_supported: ["client_credentials"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    response_types_supported: [],
    resource_indicators_supported: true,
  });
}

/** The JWKS document holding this server's public signing key. */
function jwksDocument(key: SigningKey): Response {
  return Response.json(jwks(key));
}

/** Everything {@link handleAuthRoute} needs to answer an unauthenticated route. */
export interface AuthRouteDeps {
  config: AuthConfigSource;
  key: SigningKey;
  issuer: TokenIssuer;
  peer?: string | undefined;
  /** Where a refusal the issuer never saw is recorded. */
  audit?: Logger | undefined;
}

/**
 * Route the endpoints that must be reachable **without** a credential.
 *
 * @param pathname - the request path.
 * @param request - the inbound request.
 * @param deps - see {@link AuthRouteDeps}.
 * @returns the response, or `undefined` when the path is not one of these.
 * @remarks Discovery necessarily precedes authentication, and the token endpoint
 *   authenticates the client itself — requiring a bearer token to obtain a bearer
 *   token has no solution. Nothing else is served here.
 */
export function handleAuthRoute(
  pathname: string,
  request: Request,
  deps: AuthRouteDeps,
): Promise<Response> | Response | undefined {
  if (pathname === TOKEN_PATH) {
    return handleTokenRequest(request, deps.issuer, deps.peer, deps.audit ?? NOOP_LOGGER);
  }
  if (pathname === JWKS_PATH) return jwksDocument(deps.key);
  if (pathname === PROTECTED_RESOURCE_PATH || pathname.startsWith(`${PROTECTED_RESOURCE_PATH}/`)) {
    return protectedResourceMetadata(deps.config);
  }
  if (
    pathname === AUTHORIZATION_SERVER_PATH ||
    pathname.startsWith(`${AUTHORIZATION_SERVER_PATH}/`)
  ) {
    return authorizationServerMetadata(deps.config);
  }
  return undefined;
}

/**
 * The absolute URL of this server's RFC 9728 document.
 *
 * @param config - the live auth configuration.
 * @returns the URL, derived from the configured `resource`.
 * @remarks Derived from the server's **own** identity rather than from the
 *   request's `Origin`/`Host`. A client follows this URL to discover which
 *   authorization server to trust, and `Host` is caller-controlled — the
 *   `allowedHosts` guard is empty by default and a proxy forwarding `Host`
 *   verbatim would let a caller point that discovery at an attacker's document.
 */
export function protectedResourceMetadataUrl(config: AuthConfigSource): string {
  const resource = new URL(config.current().resource);
  const path = resource.pathname === "/" ? "" : resource.pathname;
  return `${resource.origin}${PROTECTED_RESOURCE_PATH}${path}`;
}

/**
 * The `WWW-Authenticate` header a `401` on the MCP path must carry.
 *
 * @param resourceMetadataUrl - absolute URL of this server's RFC 9728 document.
 * @param code - the RFC 6750 error code.
 * @returns the header value pointing a client at how to authenticate.
 */
export function bearerChallenge(resourceMetadataUrl: string, code: string): string {
  return `Bearer error="${code}", resource_metadata="${resourceMetadataUrl}"`;
}
