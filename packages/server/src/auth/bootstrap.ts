import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import { globalPaths } from "@clarvis/paths";
import { createAuthConfigSource, type AuthConfigSource } from "./auth-config.ts";
import { createAuthenticator, type Authenticator } from "./authenticate.ts";
import { createTokenIssuer, type TokenIssuer } from "./issuer.ts";
import { loadOrCreateSigningKey, type SigningKey } from "./keys.ts";
import { createLocalTokenVerifier } from "./verifier.ts";

/** Everything the HTTP layer needs to authenticate a request and issue a token. */
export interface AuthLayer {
  authenticator: Authenticator;
  config: AuthConfigSource;
  key: SigningKey;
  issuer: TokenIssuer;
}

/** Options for {@link createAuthLayer}. */
export interface CreateAuthLayerOptions {
  /** The Clarvis global root; its `config/` holds `auth.json` and the signing key. */
  configDir: string;
  /** Overrides the default `auth.json` location. */
  authFile?: string | undefined;
  /** The externally reachable base URL, when `auth.json` names no identifiers. */
  publicUrl?: string | undefined;
  /** The MCP endpoint path, used to derive this server's resource identifier. */
  mcpPath: string;
  /**
   * Where the layer records who authenticated, and who was refused.
   *
   * @remarks A first-class audit channel rather than the reload-failure callback
   * this used to take. Enrolment reloads, token issuance and every refusal are
   * one record class with one destination, and a caller-supplied callback made
   * each of them the host's problem to remember.
   */
  audit?: Logger | undefined;
}

/**
 * Assemble the authentication layer from the operator's config directory.
 *
 * @param opts - see {@link CreateAuthLayerOptions}.
 * @returns the {@link AuthLayer}.
 * @throws {@link Error} when `auth.json` is missing, unreadable or invalid, or
 *   when the signing key on disk is corrupt. Every one of those is a boot
 *   failure on purpose: a server that cannot read its enrolment table has no
 *   safe default, and "no clients" must never degrade into "any client".
 */
export async function createAuthLayer(opts: CreateAuthLayerOptions): Promise<AuthLayer> {
  const file = opts.authFile ?? globalPaths(opts.configDir).authFile;
  const audit = opts.audit ?? NOOP_LOGGER;
  const config = createAuthConfigSource({
    file,
    defaults: { publicUrl: opts.publicUrl, mcpPath: opts.mcpPath },
    audit,
  });
  const key = await loadOrCreateSigningKey(globalPaths(opts.configDir).authKeyFile);
  return {
    config,
    key,
    issuer: createTokenIssuer({ config, key, audit }),
    authenticator: createAuthenticator({
      verifier: createLocalTokenVerifier({ config, key }),
      config,
      audit,
    }),
  };
}
