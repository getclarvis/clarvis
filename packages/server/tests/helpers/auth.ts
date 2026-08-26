import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "@clarvis/capability";
import { globalPaths } from "@clarvis/paths";
import { createAuthLayer, type AuthLayer } from "../../src/auth/bootstrap.ts";
import { SECRET_HASH_PREFIX } from "../../src/auth/secrets.ts";

/**
 * Digest a secret the way `auth.json` stores it, **without** the minimum-length
 * floor {@link hashClientSecret} enforces, so cases can use short readable
 * secrets. The floor itself is covered directly in `auth-secrets.test.ts`.
 */
export function cheapHash(secret: string): string {
  return `${SECRET_HASH_PREFIX}${createHash("sha256").update(secret, "utf8").digest("base64url")}`;
}

/** One client as it appears in `auth.json`. */
export interface TestClient {
  client_id: string;
  secret: string;
  owner: string;
  role?: string;
  disabled?: boolean;
}

/** A temporary config directory holding a live {@link AuthLayer}. */
export interface AuthFixture {
  auth: AuthLayer;
  dir: string;
  file: string;
  /** Rewrite `auth.json` in place, to exercise the reload path. */
  write(document: Record<string, unknown>): void;
  cleanup(): void;
}

/** Options for {@link makeAuthFixture}. */
export interface AuthFixtureOptions {
  clients: TestClient[];
  roles?: Record<string, unknown>;
  issuer?: string;
  resource?: string;
  tokenTtlS?: number;
  /** Captures what the layer records; silent when omitted. */
  audit?: Logger;
}

/** Build the `auth.json` document for a fixture. */
function authDocument(opts: AuthFixtureOptions): Record<string, unknown> {
  const clients = opts.clients.map((client) => ({
    client_id: client.client_id,
    secret_hash: cheapHash(client.secret),
    owner: client.owner,
    ...(client.role !== undefined ? { role: client.role } : {}),
    ...(client.disabled !== undefined ? { disabled: client.disabled } : {}),
  }));
  return {
    version: 1,
    issuer: opts.issuer ?? "https://clarvis.test",
    resource: opts.resource ?? "https://clarvis.test/mcp",
    ...(opts.tokenTtlS !== undefined ? { token_ttl_s: opts.tokenTtlS } : {}),
    clients,
    ...(opts.roles !== undefined ? { roles: opts.roles } : {}),
  };
}

/**
 * Write an `auth.json` into a temp config dir and build the layer over it.
 *
 * @param opts - the clients and roles to enrol.
 * @returns the fixture; call `cleanup()` when done.
 */
export async function makeAuthFixture(opts: AuthFixtureOptions): Promise<AuthFixture> {
  const dir = mkdtempSync(join(tmpdir(), "clarvis-auth-"));
  const file = globalPaths(dir).authFile;
  const write = (document: Record<string, unknown>): void => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(document, null, 2));
  };
  write(authDocument(opts));
  const auth = await createAuthLayer({
    configDir: dir,
    mcpPath: "/mcp",
    ...(opts.audit !== undefined ? { audit: opts.audit } : {}),
  });
  return {
    auth,
    dir,
    file,
    write,
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Exchange client credentials for an access token over the real endpoint.
 *
 * @param base - the server's origin.
 * @param clientId - the enrolled client id.
 * @param secret - its secret.
 * @param extra - additional form fields, for the error paths.
 * @returns the raw response, so a caller can assert on failures too.
 */
export function requestToken(
  base: string,
  clientId: string,
  secret: string,
  extra: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: secret,
      ...extra,
    }).toString(),
  });
}

/** Fetch a token and return it, failing loudly when the exchange did not succeed. */
export async function accessToken(base: string, clientId: string, secret: string): Promise<string> {
  const res = await requestToken(base, clientId, secret);
  if (res.status !== 200)
    throw new Error(`token request failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}
