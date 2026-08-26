import { jwtVerify, type JWTPayload } from "jose";
import type { AuthConfigSource } from "./auth-config.ts";
import type { SigningKey } from "./keys.ts";

/**
 * What a token proved, and nothing more.
 *
 * @remarks It deliberately does **not** carry the token's expiry. Every request
 * is authenticated from scratch — `serve` calls `authenticate`, which calls
 * {@link TokenVerifier.verify} — and `exp` is enforced inside that call, so a
 * session outlives its token by at most one request. A returned `expiresAt`
 * would therefore have no enforcement left to do; it existed, was never read,
 * and is gone rather than kept as a field whose presence implies a check
 * happens somewhere it does not.
 */
export interface VerifiedToken {
  /** The token's `sub`: the enrolled client id it was issued to. */
  readonly clientId: string;
}

/** Why a presented token is not acceptable; both are answered with `401`. */
export type TokenRejection = "invalid_token" | "expired_token";

/** A rejected access token. */
export class TokenError extends Error {
  readonly reason: TokenRejection;

  constructor(reason: TokenRejection, description: string, options?: ErrorOptions) {
    super(description, options);
    this.name = "TokenError";
    this.reason = reason;
  }
}

/**
 * Verifies an access token's signature, issuer, audience and lifetime.
 *
 * @remarks The seam the second authentication posture lands in. A deployment
 * validating tokens from an external identity provider swaps the implementation
 * for one reading a remote JWKS; everything downstream — the principal table,
 * the owner scoping, the role checks — is unchanged, because the enrolment
 * decision was never the token's to make.
 */
export interface TokenVerifier {
  /**
   * @param token - the raw bearer credential.
   * @returns what the token proved.
   * @throws {@link TokenError} for every rejection.
   */
  verify(token: string): Promise<VerifiedToken>;
}

/**
 * Build the verifier for tokens this server minted itself.
 *
 * @param opts - the config source (for the current issuer and resource) and the
 *   signing key whose public half validates the signature.
 * @returns the {@link TokenVerifier}.
 * @remarks `audience` is checked against the configured `resource`, so a token
 *   minted for a different service is refused here rather than being honoured by
 *   a server it was never meant for. The algorithm is pinned to the one this
 *   server signs with, which is what closes the `alg` substitution family.
 */
export function createLocalTokenVerifier(opts: {
  config: AuthConfigSource;
  key: SigningKey;
}): TokenVerifier {
  return {
    async verify(token): Promise<VerifiedToken> {
      const config = opts.config.current();
      let payload: JWTPayload;
      try {
        const verified = await jwtVerify(token, opts.key.publicKey, {
          issuer: config.issuer,
          audience: config.resource,
          algorithms: [opts.key.alg],
        });
        payload = verified.payload;
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (code === "ERR_JWT_EXPIRED") {
          throw new TokenError("expired_token", "the token expired", { cause: err });
        }
        throw new TokenError("invalid_token", "the token is not valid for this server", {
          cause: err,
        });
      }
      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new TokenError("invalid_token", "the token carries no subject");
      }
      return { clientId: payload.sub };
    },
  };
}
