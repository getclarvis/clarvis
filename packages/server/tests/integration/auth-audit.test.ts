import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAuthConfig,
  type AuthConfig,
  type AuthConfigSource,
} from "../../src/auth/auth-config.ts";
import { createAuthenticator } from "../../src/auth/authenticate.ts";
import { AuthFailure } from "../../src/auth/failure.ts";
import { createTokenIssuer } from "../../src/auth/issuer.ts";
import { loadOrCreateSigningKey, SIGNING_KEY_FILE, type SigningKey } from "../../src/auth/keys.ts";
import { TokenError, type TokenVerifier } from "../../src/auth/verifier.ts";
import { cheapHash } from "../helpers/auth.ts";
import { recordingLoggers, type RecordingLoggers } from "../helpers/harness.ts";

const SECRET = "s3cret";

/** A static {@link AuthConfigSource} over one parsed configuration. */
function sourceOf(config: AuthConfig): AuthConfigSource {
  return { path: "<memory>", current: () => config };
}

function config(over: Record<string, unknown> = {}): AuthConfig {
  return parseAuthConfig(
    {
      version: 1,
      issuer: "https://clarvis.test",
      resource: "https://clarvis.test/mcp",
      clients: [{ client_id: "svc", secret_hash: cheapHash(SECRET), owner: "acme" }],
      ...over,
    },
    { mcpPath: "/mcp" },
  );
}

/** A temp directory, removed after `body` settles. */
async function withKey(body: (key: SigningKey) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "clarvis-auth-audit-"));
  try {
    await body(await loadOrCreateSigningKey(join(dir, SIGNING_KEY_FILE)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Assert no record on either channel carries a secret or its digest. */
function expectNoCredential(logs: RecordingLoggers): void {
  const dump = JSON.stringify(logs.records);
  expect(dump).not.toContain(SECRET);
  expect(dump).not.toContain(cheapHash(SECRET));
  expect(dump.toLowerCase()).not.toContain("authorization");
}

describe("the token issuer's audit records", () => {
  it("records a successful exchange, without the credential that bought it", async () => {
    await withKey(async (key) => {
      const logs = recordingLoggers();
      const issuer = createTokenIssuer({
        config: sourceOf(config()),
        key,
        audit: logs.loggers.audit,
      });

      await issuer.issue({
        grantType: "client_credentials",
        clientId: "svc",
        clientSecret: SECRET,
        peer: "203.0.113.7",
      });

      const record = logs.one("auth.token.issued");
      expect(record.channel).toBe("audit");
      expect(record.level).toBe("info");
      expect(record.fields).toMatchObject({
        client_id: "svc",
        expires_in: 3600,
        peer: "203.0.113.7",
      });
      expectNoCredential(logs);
    });
  });

  it("names the reason for each shape of refusal", async () => {
    await withKey(async (key) => {
      const logs = recordingLoggers();
      const issuer = createTokenIssuer({
        config: sourceOf(config()),
        key,
        audit: logs.loggers.audit,
      });
      const attempt = (over: Record<string, unknown>): Promise<unknown> =>
        issuer
          .issue({
            grantType: "client_credentials",
            clientId: "svc",
            clientSecret: SECRET,
            ...over,
          })
          .catch(() => undefined);

      await attempt({ grantType: "password" });
      await attempt({ scope: "admin" });
      await attempt({ resource: "https://elsewhere.test/mcp" });
      await attempt({ clientSecret: undefined });
      await attempt({ clientSecret: "wrong", peer: "198.51.100.4" });
      await attempt({ clientId: "x".repeat(200) });

      const reasons = logs.find("auth.token.rejected").map((record) => record.fields.reason);
      expect(reasons).toEqual([
        "unsupported_grant_type",
        "invalid_scope",
        "invalid_target",
        "invalid_client",
        "invalid_client",
        "invalid_client",
      ]);
      expect(logs.find("auth.token.rejected").every((r) => r.level === "warn")).toBe(true);
      expectNoCredential(logs);
    });
  });

  it("omits the client id when the request never presented a usable one", async () => {
    await withKey(async (key) => {
      const logs = recordingLoggers();
      const issuer = createTokenIssuer({
        config: sourceOf(config()),
        key,
        audit: logs.loggers.audit,
      });

      await issuer
        .issue({ grantType: "client_credentials", clientId: undefined, clientSecret: undefined })
        .catch(() => undefined);

      const record = logs.one("auth.token.rejected");
      expect(record.fields.client_id).toBeUndefined();
      expect(record.fields.peer).toBe("unknown");
    });
  });

  it("records a throttle as its own thing, naming which budget was spent", async () => {
    await withKey(async (key) => {
      const logs = recordingLoggers();
      const issuer = createTokenIssuer({
        config: sourceOf(config()),
        key,
        audit: logs.loggers.audit,
      });
      const attempt = (secret: string): Promise<unknown> =>
        issuer
          .issue({
            grantType: "client_credentials",
            clientId: "svc",
            clientSecret: secret,
            peer: "203.0.113.7",
          })
          .catch(() => undefined);

      for (let guess = 0; guess < 12; guess += 1) await attempt("wrong");
      await attempt(SECRET);

      const throttled = logs.find("auth.token.throttled");
      expect(throttled.length).toBeGreaterThan(0);
      expect(throttled[0]?.fields).toMatchObject({
        client_id: "svc",
        peer: "203.0.113.7",
        budget: "client",
        retry_after_s: 60,
      });
    });
  });
});

describe("the authenticator's audit records", () => {
  const verifier = (result: "ok" | "bad" | "boom"): TokenVerifier => ({
    verify: (): Promise<{ clientId: string }> => {
      if (result === "bad") return Promise.reject(new TokenError("expired_token", "it expired"));
      if (result === "boom") return Promise.reject(new Error("something else"));
      return Promise.resolve({ clientId: "svc" });
    },
  });

  const request = (headers: Record<string, string> = {}): Request =>
    new Request("http://127.0.0.1/mcp", { headers });

  it("records a request that presented no credential", async () => {
    const logs = recordingLoggers();
    const authenticator = createAuthenticator({
      verifier: verifier("ok"),
      config: sourceOf(config()),
      audit: logs.loggers.audit,
    });

    await expect(authenticator.authenticate(request())).rejects.toBeInstanceOf(AuthFailure);
    expect(logs.one("auth.request.rejected").fields).toMatchObject({
      reason: "invalid_request",
      status: 401,
    });
    expect(logs.one("auth.request.rejected").fields.client_id).toBeUndefined();
  });

  it("carries the verifier's own reason, and never the token", async () => {
    const logs = recordingLoggers();
    const authenticator = createAuthenticator({
      verifier: verifier("bad"),
      config: sourceOf(config()),
      audit: logs.loggers.audit,
    });

    await expect(
      authenticator.authenticate(request({ authorization: "Bearer s3cret-token" })),
    ).rejects.toBeInstanceOf(AuthFailure);
    expect(logs.one("auth.request.rejected").fields.reason).toBe("expired_token");
    expect(JSON.stringify(logs.records)).not.toContain("s3cret-token");
  });

  it("falls back to invalid_token for a verifier that threw something else", async () => {
    const logs = recordingLoggers();
    const authenticator = createAuthenticator({
      verifier: verifier("boom"),
      config: sourceOf(config()),
      audit: logs.loggers.audit,
    });

    await expect(
      authenticator.authenticate(request({ authorization: "Bearer t" })),
    ).rejects.toBeInstanceOf(AuthFailure);
    expect(logs.one("auth.request.rejected").fields.reason).toBe("invalid_token");
  });

  it("names the client for a token that verified but is no longer enrolled", async () => {
    const logs = recordingLoggers();
    const authenticator = createAuthenticator({
      verifier: verifier("ok"),
      config: sourceOf(
        config({
          clients: [
            { client_id: "svc", secret_hash: cheapHash(SECRET), owner: "acme", disabled: true },
          ],
        }),
      ),
      audit: logs.loggers.audit,
    });

    await expect(
      authenticator.authenticate(request({ authorization: "Bearer t" })),
    ).rejects.toBeInstanceOf(AuthFailure);
    expect(logs.one("auth.request.rejected").fields).toMatchObject({
      reason: "disabled_client",
      status: 403,
      client_id: "svc",
    });
  });

  it("says nothing at all for a request it admits", async () => {
    const logs = recordingLoggers();
    const authenticator = createAuthenticator({
      verifier: verifier("ok"),
      config: sourceOf(config()),
      audit: logs.loggers.audit,
    });

    await expect(
      authenticator.authenticate(request({ authorization: "Bearer t" })),
    ).resolves.toMatchObject({ clientId: "svc", owner: "acme" });
    expect(logs.records).toHaveLength(0);
  });
});
