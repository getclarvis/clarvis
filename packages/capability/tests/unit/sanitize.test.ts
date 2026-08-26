import { describe, it, expect } from "../helpers/bun-test.ts";
import {
  sanitizeDeep,
  sanitizeErrorMessage,
  sanitizeText,
  sanitizeToolPayload,
} from "../../src/sanitize.ts";

describe("sanitizeErrorMessage — named secret patterns", () => {
  it("redacts a Bearer token", () => {
    expect(sanitizeErrorMessage("Authorization: Bearer abc.DEF-123_xyz here")).toContain(
      "Bearer [redacted]",
    );
  });

  it("redacts an sk- key", () => {
    const out = sanitizeErrorMessage("bad key sk-proj-ABCDEFGH12345678 rejected");
    expect(out).toContain("sk-[redacted]");
    expect(out).not.toContain("ABCDEFGH12345678");
  });

  it("redacts a bare JWT by shape", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36abc";
    expect(sanitizeErrorMessage(`upstream rejected ${jwt}`)).toContain("[redacted-jwt]");
  });

  it("redacts a JWT introduced by a sensitive key", () => {
    // `token=` no longer matches the key/value rule — that rule requires a
    // quoted value now, so it does not maul source code — and the JWT shape
    // rule catches this, which is the more informative label anyway.
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36abc";
    const out = sanitizeErrorMessage(`token=${jwt}`);
    expect(out).toContain("[redacted-jwt]");
    expect(out).not.toContain(jwt);
  });

  it("redacts credentials in a URL but keeps scheme + host", () => {
    const out = sanitizeErrorMessage("connect to https://user:secretpw@db.example.com/x failed");
    expect(out).toContain("https://[redacted]@db.example.com");
    expect(out).not.toContain("secretpw");
  });

  it("redacts a secret query-param value", () => {
    const out = sanitizeErrorMessage("GET /v1?api_key=SUPERSECRETVALUE&n=1 failed");
    expect(out).toContain("api_key=[redacted]");
    expect(out).not.toContain("SUPERSECRETVALUE");
  });

  it("does NOT over-redact a 40-char hash (git SHA-ish)", () => {
    const sha = "a".repeat(40);
    expect(sanitizeErrorMessage(`commit ${sha} ok`)).toContain(sha);
  });

  it("redacts a long opaque 64+ token via the coarse fallback", () => {
    const blob = "Z".repeat(70);
    const out = sanitizeErrorMessage(`blob ${blob} end`);
    expect(out).toContain("[redacted]");
    expect(out).not.toContain(blob);
  });

  it("redacts password-only URL userinfo (no username)", () => {
    const out = sanitizeErrorMessage("redis://:s3cr3tPass@cache:6379 refused");
    expect(out).toContain("redis://[redacted]@cache:6379");
    expect(out).not.toContain("s3cr3tPass");
  });

  it("redacts token-only URL userinfo (no colon)", () => {
    const out = sanitizeErrorMessage("clone https://ghp_TOKENvalue123@github.com/x failed");
    expect(out).not.toContain("ghp_TOKENvalue123");
    expect(out).toContain("https://[redacted]@github.com");
  });

  it("redacts a GitHub token by prefix", () => {
    const out = sanitizeErrorMessage("auth ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 denied");
    expect(out).toContain("[redacted-github-token]");
    expect(out).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  });

  it("redacts an AWS access key id", () => {
    const out = sanitizeErrorMessage("using AKIAIOSFODNN7EXAMPLE failed");
    expect(out).toContain("[redacted-aws-key]");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts a Slack token", () => {
    const out = sanitizeErrorMessage("xoxb-123456789012-ABCDEFghijkl rejected");
    expect(out).toContain("[redacted-slack-token]");
    expect(out).not.toContain("ABCDEFghijkl");
  });

  it("redacts non-listed secret query params (client_secret, password, signature)", () => {
    for (const [name, value] of [
      ["client_secret", "CSVALUE123"],
      ["password", "hunter2pw"],
      ["signature", "SIGVALUE456"],
    ] as const) {
      const out = sanitizeErrorMessage(`GET /v1?${name}=${value}&n=1 failed`);
      expect(out).toContain(`${name}=[redacted]`);
      expect(out).not.toContain(value);
    }
  });

  it("redacts a Basic auth credential", () => {
    const out = sanitizeErrorMessage("auth via Basic dXNlcjpwYXNzd29yZA== denied");
    expect(out).toContain("Basic [redacted]");
    expect(out).not.toContain("dXNlcjpwYXNzd29yZA");
  });

  it("redacts a header-named secret value (x-api-key) that is not a Bearer/sk- token", () => {
    const out = sanitizeErrorMessage("sent x-api-key: OPAQUEvalue123 to upstream");
    expect(out).toContain("x-api-key: [redacted]");
    expect(out).not.toContain("OPAQUEvalue123");
  });

  it("redacts api_key=value assignment", () => {
    const out = sanitizeErrorMessage("config api_key=OPAQUEvalue123 loaded");
    expect(out).toContain("api_key: [redacted]");
    expect(out).not.toContain("OPAQUEvalue123");
  });

  it("does NOT redact a header name used in prose without a value", () => {
    expect(sanitizeErrorMessage("authorization failed for user")).toBe(
      "authorization failed for user",
    );
  });
});

describe("sanitizeToolPayload — named patterns, no coarse fallback", () => {
  // The payload rule set exists because the coarse fallback is wrong here: a
  // tool argument or result is mostly long non-secret tokens, and blanking them
  // destroys the content the trace exists to show.
  it("keeps a long opaque token that matches no named pattern", () => {
    const blob = "Z".repeat(70);
    const out = sanitizeToolPayload(`file contents: ${blob}`);
    expect(out).toContain(blob);
  });

  it("keeps a base64 image blob and a lockfile integrity hash intact", () => {
    const b64 = "iVBORw0KGgoAAAANSUhEUg" + "A".repeat(80);
    const integrity = "sha512-" + "b".repeat(60);
    expect(sanitizeToolPayload(`data:image/png;base64,${b64}`)).toContain(b64);
    expect(sanitizeToolPayload(`"integrity": "${integrity}"`)).toContain(integrity);
  });

  it("leaves ordinary source code alone", () => {
    // This rule set runs over every persisted tool argument and result, and
    // rehydration replays the trace — so an unquoted `key = value` match would
    // make a restored session show `const token: [redacted]` as the file's
    // actual contents.
    for (const line of [
      "const token = getToken(req);",
      "let password = form.password;",
      "if (secret === x) return;",
      "export const pwd = process.cwd();",
    ]) {
      expect(sanitizeToolPayload(line)).toBe(line);
    }
  });

  it("still redacts those same keys when the value is quoted", () => {
    for (const [input, gone] of [
      ['password: "hunter2"', "hunter2"],
      ["token = 'eyJopaquevalue'", "eyJopaquevalue"],
      ['secret: "s3cr3t"', "s3cr3t"],
    ] as const) {
      const out = sanitizeToolPayload(input);
      expect(out).toContain("[redacted]");
      expect(out).not.toContain(gone);
    }
  });

  it("keeps a 40-char git SHA", () => {
    const sha = "a".repeat(40);
    expect(sanitizeToolPayload(`commit ${sha} ok`)).toContain(sha);
  });

  it("still redacts named patterns (Bearer, sk-)", () => {
    expect(sanitizeToolPayload("Authorization: Bearer abc.DEF-123_xyz")).toContain(
      "Bearer [redacted]",
    );
    expect(sanitizeToolPayload("key sk-proj-ABCDEFGH12345678")).toContain("sk-[redacted]");
  });

  it("still redacts a PEM private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
    const out = sanitizeToolPayload(`key file: ${pem}`);
    expect(out).toContain("[redacted-private-key]");
    expect(out).not.toContain("MIIEow");
  });

  it("redacts secrets serialized as JSON inside free text", () => {
    const out = sanitizeToolPayload(
      'upstream error: {"api_key":"opaqueJSONsecretValue","status":401}',
    );
    expect(out).toContain('"api_key": "[redacted]"');
    expect(out).not.toContain("opaqueJSONsecretValue");
  });

  it("redacts JSON secret values that contain escaped quotes (no leak past the escape)", () => {
    const out = sanitizeToolPayload('body: {"password":"foo\\"bar\\"baz","n":1}');
    expect(out).toContain('"password": "[redacted]"');
    expect(out).not.toContain("bar");
    expect(out).not.toContain("baz");
  });

  it("redacts short secrets under compound JSON keys the object-walk already catches", () => {
    for (const key of [
      "client_secret",
      "access_token",
      "accessToken",
      "clientSecret",
      "appSecret",
    ]) {
      const out = sanitizeToolPayload(`upstream error: {"${key}":"shortValue123","status":401}`);
      expect(out, key).toContain(`"${key}": "[redacted]"`);
      expect(out, key).not.toContain("shortValue123");
    }
  });

  it("does not redact the value of a non-sensitive key", () => {
    const out = sanitizeToolPayload('{"username":"alice","status":"ok"}');
    expect(out).toContain('"username":"alice"');
    expect(out).toContain('"status":"ok"');
  });
});

describe("sanitizeErrorMessage — keeps the coarse fallback", () => {
  // An error message is short and its long tokens are overwhelmingly secrets,
  // so the aggressive rule earns its false positives here and only here.
  it("redacts a long opaque token no named pattern matches", () => {
    const blob = "Z".repeat(70);
    const out = sanitizeErrorMessage(`upstream returned ${blob} verbatim`);
    expect(out).toContain("[redacted]");
    expect(out).not.toContain(blob);
  });

  it("redacts a medium-length 48-char opaque token", () => {
    const token = "Q".repeat(48);
    const out = sanitizeErrorMessage(`opaque ${token} end`);
    expect(out).toContain("[redacted]");
    expect(out).not.toContain(token);
  });

  it("does NOT over-redact a 40-char hash (git SHA-ish)", () => {
    const sha = "a".repeat(40);
    expect(sanitizeErrorMessage(`commit ${sha} ok`)).toContain(sha);
  });
});

describe("sanitizeDeep — recursive redaction", () => {
  it("redacts string leaves inside nested objects and arrays", () => {
    const out = sanitizeDeep({
      headers: { authorization: "Bearer abc.DEF-123_xyz" },
      nested: [
        "sk-proj-ABCDEFGH12345678",
        { jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxabc" },
      ],
      count: 7,
      ok: true,
    }) as Record<string, unknown>;
    const flat = JSON.stringify(out);
    expect(flat).toContain("Bearer [redacted]");
    expect(flat).toContain("sk-[redacted]");
    expect(flat).toContain("[redacted-jwt]");
    expect(flat).not.toContain("ABCDEFGH12345678");
    expect((out as { count: number }).count).toBe(7);
    expect((out as { ok: boolean }).ok).toBe(true);
  });

  it("passes non-string primitives through unchanged", () => {
    expect(sanitizeDeep(42)).toBe(42);
    expect(sanitizeDeep(null)).toBe(null);
    expect(sanitizeDeep(undefined)).toBe(undefined);
  });

  it("redacts short opaque secret values under sensitive keys (key-aware)", () => {
    const out = sanitizeDeep({
      api_key: "abc123short",
      apiKey: "Camel123",
      config: { client_secret: "xyzShort", refresh_token: "rt-Short9" },
      access_token: "at-Short8",
      label: "not-a-secret",
      max_tokens: 4096,
    }) as Record<string, unknown>;
    const flat = JSON.stringify(out);
    expect(flat).not.toContain("abc123short");
    expect(flat).not.toContain("Camel123");
    expect(flat).not.toContain("xyzShort");
    expect(flat).not.toContain("rt-Short9");
    expect(flat).not.toContain("at-Short8");
    expect(out.api_key).toBe("[redacted]");
    expect(out.label).toBe("not-a-secret");
    expect(out.max_tokens).toBe(4096);
  });
});

describe("sanitizeText — the free-text rule set", () => {
  it("redacts an unquoted assignment the trace rule set deliberately leaves alone", () => {
    expect(sanitizeText("export TOKEN=supersecretvalue")).toContain("[redacted]");
    expect(sanitizeToolPayload("export TOKEN=supersecretvalue")).toContain("supersecretvalue");
  });

  it("redacts the shapes both rule sets agree on", () => {
    expect(sanitizeText("Authorization: Bearer abc.def-123")).toContain("Bearer [redacted]");
    expect(sanitizeText('{"apiKey": "sk-verysecretvalue"}')).toContain('"apiKey": "[redacted]"');
    expect(sanitizeText("ghp_0123456789abcdefghij0123456789")).toContain("[redacted-github-token]");
  });

  it("keeps ordinary file paths intact", () => {
    const text = "edited packages/memory/src/store.ts and ran bun test";
    expect(sanitizeText(text)).toBe(text);
  });

  it("still redacts URL userinfo after the scheme was bounded", () => {
    expect(sanitizeText("https://user:pw@example.com/x")).toBe("https://[redacted]@example.com/x");
    expect(sanitizeText("postgres://admin:s3cret@db:5432/app")).toBe(
      "postgres://[redacted]@db:5432/app",
    );
  });
});

describe("sanitizeDeep — the redactor is the caller's choice", () => {
  it("applies the coarse fallback only when handed the free-text redactor", () => {
    const long = "z".repeat(60);
    const value = { note: long };

    expect(sanitizeDeep(value).note).toBe(long);
    expect(sanitizeDeep(value, sanitizeText).note).toBe("[redacted]");
  });

  it("redacts a sensitively-keyed value the same way under either redactor", () => {
    const value = { password: "hunter2", note: "fine", nested: { token: "abcd1234efgh" } };

    for (const out of [sanitizeDeep(value), sanitizeDeep(value, sanitizeText)]) {
      expect(out.password).toBe("[redacted]");
      expect(out.note).toBe("fine");
      expect(out.nested.token).toBe("[redacted]");
    }
  });
});
