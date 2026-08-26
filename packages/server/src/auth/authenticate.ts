import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type { AuthConfigSource } from "./auth-config.ts";
import { AuthFailure } from "./failure.ts";
import { resolvePrincipal, type Principal } from "./principals.ts";
import { TokenError, type TokenVerifier } from "./verifier.ts";

/** Turns a request's `Authorization` header into the caller it stands for. */
export interface Authenticator {
  /**
   * @param request - the inbound request.
   * @returns the authenticated {@link Principal}.
   * @throws {@link AuthFailure} when no usable credential is present, or when the
   *   credential is valid but its client is no longer enrolled.
   */
  authenticate(request: Request): Promise<Principal>;
}

/**
 * Read a bearer credential out of an `Authorization` header.
 *
 * @returns the token, or `undefined` when the header is missing or is not a
 *   bearer credential.
 */
function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (header === null) return undefined;
  const match = /^Bearer[ ]+(?<token>[^\s]+)$/i.exec(header.trim());
  return match?.groups?.token;
}

/**
 * Record one refused request, and return the failure to throw.
 *
 * @param audit - the audit channel.
 * @param failure - the refusal, already carrying its status and reason.
 * @param clientId - the caller's id, when the credential named one this server
 *   could read; absent for a request that presented nothing usable.
 * @returns `failure`, so a caller writes `throw rejected(...)`.
 * @remarks Neither the token nor the `Authorization` header is a field, at any
 * level. The reason and the status are what an operator needs to tell a missing
 * credential from a revoked client.
 */
function rejected(audit: Logger, failure: AuthFailure, clientId?: string): AuthFailure {
  audit.warn(
    {
      event: "auth.request.rejected",
      reason: failure.code,
      status: failure.status,
      ...(clientId !== undefined ? { client_id: clientId } : {}),
    },
    "a request was refused before it reached the MCP endpoint; nothing was run for it",
  );
  return failure;
}

/**
 * Build the {@link Authenticator} over a verifier and the enrolment table.
 *
 * @param opts - the token verifier, the live auth configuration and the audit
 *   channel every refusal is recorded on.
 * @returns the authenticator.
 * @remarks Verification and enrolment are two separate decisions on purpose. A
 *   token can be perfectly valid and still identify nobody this server serves —
 *   that is the whole point of enrolment living in a file the operator writes —
 *   and it is answered `403`, before any owner directory is provisioned for it.
 */
export function createAuthenticator(opts: {
  verifier: TokenVerifier;
  config: AuthConfigSource;
  audit?: Logger;
}): Authenticator {
  const audit = opts.audit ?? NOOP_LOGGER;
  return {
    async authenticate(request): Promise<Principal> {
      const token = bearerToken(request);
      if (token === undefined) {
        throw rejected(
          audit,
          new AuthFailure(401, "invalid_request", "a bearer access token is required"),
        );
      }
      let verified;
      try {
        verified = await opts.verifier.verify(token);
      } catch (err) {
        throw rejected(audit, unverifiable(err));
      }
      const resolved = resolvePrincipal(opts.config.current(), verified.clientId);
      if (!resolved.ok) {
        throw rejected(
          audit,
          new AuthFailure(
            403,
            resolved.reason,
            resolved.reason === "disabled_client"
              ? "this client is disabled"
              : "this client is not enrolled on this server",
          ),
          verified.clientId,
        );
      }
      return resolved.principal;
    },
  };
}

/**
 * Turn a verifier's rejection into the failure the caller is answered with.
 *
 * @param err - whatever the verifier threw.
 * @returns the `401`, carrying the verifier's own reason when it had one.
 */
function unverifiable(err: unknown): AuthFailure {
  if (err instanceof TokenError) return new AuthFailure(401, err.reason, err.message);
  return new AuthFailure(401, "invalid_token", "the token could not be verified");
}
