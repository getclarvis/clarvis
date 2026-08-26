import { describe, it, expect } from "bun:test";
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAuthConfig,
  type AuthConfig,
  type AuthConfigSource,
} from "../../src/auth/auth-config.ts";
import { createTokenIssuer, OAuthError } from "../../src/auth/issuer.ts";
import { loadOrCreateSigningKey, SIGNING_KEY_FILE } from "../../src/auth/keys.ts";
import { loadServerEnv } from "../../src/config/env.ts";
import { serveClarvisMcpOverHttp } from "../../src/http/serve.ts";
import { cheapHash } from "../helpers/auth.ts";
import { recordingLoggers, SILENT_LOGGERS } from "../helpers/harness.ts";

/** A temp directory, removed after `body` settles. */
async function withDir(body: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "clarvis-auth-edge-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A static {@link AuthConfigSource} over one parsed configuration. */
function sourceOf(config: AuthConfig): AuthConfigSource {
  return { path: "<memory>", current: () => config };
}

describe("the signing key", () => {
  it("generates once, at 0600, and reloads the same key id afterwards", async () => {
    await withDir(async (dir) => {
      const keyFile = join(dir, SIGNING_KEY_FILE);
      const first = await loadOrCreateSigningKey(keyFile);
      expect(first.alg).toBe("EdDSA");
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      expect(first.publicJwk.d).toBeUndefined();

      const second = await loadOrCreateSigningKey(keyFile);
      expect(second.kid).toBe(first.kid);
    });
  });

  it("refuses a corrupt key file rather than minting a replacement", async () => {
    await withDir(async (dir) => {
      const keyFile = join(dir, SIGNING_KEY_FILE);
      writeFileSync(keyFile, "{ truncated");
      await expect(loadOrCreateSigningKey(keyFile)).rejects.toThrow(/not valid JSON/);

      writeFileSync(keyFile, JSON.stringify({ kty: "RSA", n: "x" }));
      await expect(loadOrCreateSigningKey(keyFile)).rejects.toThrow(
        /not a valid Ed25519 private JWK/,
      );
    });
  });

  it("refuses an oversized sparse key before parsing it", async () => {
    await withDir(async (dir) => {
      const keyFile = join(dir, SIGNING_KEY_FILE);
      const fd = openSync(keyFile, "w");
      try {
        truncateSync(keyFile, 64 * 1024 * 1024);
      } finally {
        closeSync(fd);
      }
      await expect(loadOrCreateSigningKey(keyFile)).rejects.toThrow(/not valid JSON/);
    });
  });
});

describe("the token issuer", () => {
  const SECRET = "s";
  const config = (): AuthConfig =>
    parseAuthConfig(
      {
        version: 1,
        issuer: "https://clarvis.test",
        resource: "https://clarvis.test/mcp",
        clients: [{ client_id: "svc", secret_hash: cheapHash(SECRET), owner: "acme" }],
      },
      { mcpPath: "/mcp" },
    );

  it("cannot have its budget spent by a caller at another address", async () => {
    await withDir(async (dir) => {
      const issuer = createTokenIssuer({
        config: sourceOf(config()),
        key: await loadOrCreateSigningKey(join(dir, SIGNING_KEY_FILE)),
      });
      const attempt = (secret: string, peer: string): Promise<unknown> =>
        issuer.issue({
          grantType: "client_credentials",
          clientId: "svc",
          clientSecret: secret,
          peer,
        });

      for (let guess = 0; guess < 12; guess += 1) {
        await attempt("wrong", "203.0.113.7").catch(() => undefined);
      }
      await expect(attempt(SECRET, "203.0.113.7")).rejects.toMatchObject({ error: "slow_down" });

      await expect(attempt(SECRET, "198.51.100.4")).resolves.toMatchObject({
        token_type: "Bearer",
      });
    });
  });

  it("requires both halves of the credential", async () => {
    await withDir(async (dir) => {
      const issuer = createTokenIssuer({
        config: sourceOf(config()),
        key: await loadOrCreateSigningKey(join(dir, SIGNING_KEY_FILE)),
      });
      await expect(
        issuer.issue({ grantType: "client_credentials", clientId: "svc", clientSecret: undefined }),
      ).rejects.toBeInstanceOf(OAuthError);
    });
  });
});

describe("the token endpoint's request parsing", () => {
  /** Serve one endpoint whose issuer accepts any secret, to isolate parsing. */
  async function serve(dir: string) {
    const key = await loadOrCreateSigningKey(join(dir, SIGNING_KEY_FILE));
    const config = sourceOf(
      parseAuthConfig(
        {
          version: 1,
          issuer: "https://clarvis.test",
          resource: "https://clarvis.test/mcp",
          clients: [
            { client_id: "svc:1", secret_hash: cheapHash("p@ss:word"), owner: "acme" },
            { client_id: "spaced", secret_hash: cheapHash("two words"), owner: "acme" },
          ],
        },
        { mcpPath: "/mcp" },
      ),
    );
    const key2 = key;
    const handle = serveClarvisMcpOverHttp({
      env: loadServerEnv({
        CLARVIS_SERVER_PORT: "0",
        CLARVIS_SERVER_HOST: "127.0.0.1",
        CLARVIS_SERVER_AUTH: "required",
      }),
      logger: SILENT_LOGGERS,
      resolveKernel: () => {
        throw new Error("unreachable");
      },
      auth: {
        config,
        key: key2,
        issuer: createTokenIssuer({ config, key: key2 }),
        authenticator: { authenticate: () => Promise.reject(new Error("unreachable")) },
      },
    });
    return { handle, base: `http://127.0.0.1:${handle.port}` };
  }

  it("answers 503 and records it when the issuer fails for a reason of its own", async () => {
    await withDir(async (dir) => {
      const key = await loadOrCreateSigningKey(join(dir, SIGNING_KEY_FILE));
      const config = sourceOf(
        parseAuthConfig(
          {
            version: 1,
            issuer: "https://clarvis.test",
            resource: "https://clarvis.test/mcp",
            clients: [{ client_id: "svc", secret_hash: cheapHash("s"), owner: "acme" }],
          },
          { mcpPath: "/mcp" },
        ),
      );
      const logs = recordingLoggers();
      const handle = serveClarvisMcpOverHttp({
        env: loadServerEnv({
          CLARVIS_SERVER_PORT: "0",
          CLARVIS_SERVER_HOST: "127.0.0.1",
          CLARVIS_SERVER_AUTH: "required",
        }),
        logger: logs.loggers,
        resolveKernel: () => {
          throw new Error("unreachable");
        },
        auth: {
          config,
          key,
          issuer: { issue: () => Promise.reject(new Error("the signer is on fire")) },
          authenticator: { authenticate: () => Promise.reject(new Error("unreachable")) },
        },
      });
      try {
        const res = await fetch(`http://127.0.0.1:${handle.port}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "grant_type=client_credentials&client_id=svc&client_secret=s",
        });
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ error: "temporarily_unavailable" });
        expect(logs.one("auth.token.rejected").fields).toMatchObject({
          reason: "temporarily_unavailable",
          status: 503,
        });
        expect(JSON.stringify(logs.records)).not.toContain("the signer is on fire");
      } finally {
        await handle.close();
      }
    });
  });

  it("rejects a body that is not form-encoded, and one that is too large", async () => {
    await withDir(async (dir) => {
      const { handle, base } = await serve(dir);
      try {
        const wrongType = await fetch(`${base}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(await wrongType.json()).toMatchObject({ error: "invalid_request" });

        const huge = await fetch(`${base}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `grant_type=client_credentials&client_secret=${"x".repeat(9_000)}`,
        });
        expect(await huge.json()).toMatchObject({ error: "invalid_request" });
      } finally {
        await handle.close();
      }
    });
  });

  it("reads a '+' in a Basic secret as the space RFC 6749 form-encoding makes it", async () => {
    await withDir(async (dir) => {
      const { handle, base } = await serve(dir);
      try {
        const credentials = Buffer.from("spaced:two+words").toString("base64");
        const res = await fetch(`${base}/oauth/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Basic ${credentials}`,
          },
          body: "grant_type=client_credentials",
        });
        expect(res.status).toBe(200);
      } finally {
        await handle.close();
      }
    });
  });

  it("decodes Basic credentials that RFC 6749 form-encoded, and ignores a malformed header", async () => {
    await withDir(async (dir) => {
      const { handle, base } = await serve(dir);
      try {
        const encoded = `${encodeURIComponent("svc:1")}:${encodeURIComponent("p@ss:word")}`;
        const ok = await fetch(`${base}/oauth/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Basic ${Buffer.from(encoded).toString("base64")}`,
          },
          body: "grant_type=client_credentials",
        });
        expect(ok.status).toBe(200);

        const noColon = await fetch(`${base}/oauth/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Basic ${Buffer.from("nocolon").toString("base64")}`,
          },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: "svc:1",
            client_secret: "p@ss:word",
          }).toString(),
        });
        expect(noColon.status).toBe(200);
      } finally {
        await handle.close();
      }
    });
  });
});

describe("misconfiguration", () => {
  it("refuses to serve an auth layer while the auth switch is off", async () => {
    await withDir(async (dir) => {
      const key = await loadOrCreateSigningKey(join(dir, SIGNING_KEY_FILE));
      const config = sourceOf(
        parseAuthConfig(
          {
            version: 1,
            issuer: "https://clarvis.test",
            resource: "https://clarvis.test/mcp",
            clients: [{ client_id: "svc", secret_hash: cheapHash("s"), owner: "acme" }],
          },
          { mcpPath: "/mcp" },
        ),
      );
      expect(() =>
        serveClarvisMcpOverHttp({
          env: loadServerEnv({ CLARVIS_SERVER_PORT: "0", CLARVIS_SERVER_AUTH: "off" }),
          logger: SILENT_LOGGERS,
          resolveKernel: () => {
            throw new Error("unreachable");
          },
          auth: {
            config,
            key,
            issuer: createTokenIssuer({ config, key }),
            authenticator: { authenticate: () => Promise.reject(new Error("unreachable")) },
          },
        }),
      ).toThrow(/one switch decides whether this endpoint is protected/);
    });
  });
});
