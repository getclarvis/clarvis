import { describe, it, expect } from "bun:test";
import {
  generateClientSecret,
  hashClientSecret,
  isClientSecretHash,
  MIN_CLIENT_SECRET_LENGTH,
  SECRET_HASH_PREFIX,
  UNMATCHABLE_SECRET_HASH,
  verifyClientSecret,
} from "../../src/auth/secrets.ts";

describe("generateClientSecret", () => {
  it("emits 256 bits, which is what lets the stored digest be a fast one", () => {
    const secret = generateClientSecret();
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    expect(secret.length).toBeGreaterThanOrEqual(MIN_CLIENT_SECRET_LENGTH);
    expect(secret).not.toBe(generateClientSecret());
  });
});

describe("hashClientSecret", () => {
  it("round-trips a generated secret", () => {
    const secret = generateClientSecret();
    const stored = hashClientSecret(secret);
    expect(stored.startsWith(SECRET_HASH_PREFIX)).toBe(true);
    expect(isClientSecretHash(stored)).toBe(true);
    expect(verifyClientSecret(secret, stored)).toBe(true);
    expect(verifyClientSecret(generateClientSecret(), stored)).toBe(false);
  });

  it("refuses a secret too short to carry the entropy the fast digest relies on", () => {
    expect(() => hashClientSecret("hunter2")).toThrow(/at least 32 characters/);
    expect(() => hashClientSecret("x".repeat(MIN_CLIENT_SECRET_LENGTH - 1))).toThrow();
    expect(() => hashClientSecret("x".repeat(MIN_CLIENT_SECRET_LENGTH))).not.toThrow();
  });

  it("is deterministic, so an operator can re-derive a digest from the secret", () => {
    const secret = generateClientSecret();
    expect(hashClientSecret(secret)).toBe(hashClientSecret(secret));
  });
});

describe("verifyClientSecret", () => {
  it("refuses a stored value that is not a digest of the right shape", () => {
    expect(verifyClientSecret("anything", "hunter2")).toBe(false);
    expect(verifyClientSecret("anything", "sha256:dG9vLXNob3J0")).toBe(false);
    expect(verifyClientSecret("anything", "$argon2id$v=19$m=8,t=1,p=1$c2FsdA$aaaa")).toBe(false);
  });

  it("refuses non-canonical base64url even when the decoder yields 32 bytes", () => {
    const canonical = hashClientSecret("x".repeat(MIN_CLIENT_SECRET_LENGTH));
    const payload = canonical.slice(SECRET_HASH_PREFIX.length);
    for (const malformed of [`${payload}=`, `${"A".repeat(42)}+`]) {
      expect(isClientSecretHash(`${SECRET_HASH_PREFIX}${malformed}`)).toBe(false);
      expect(
        verifyClientSecret(
          "x".repeat(MIN_CLIENT_SECRET_LENGTH),
          `${SECRET_HASH_PREFIX}${malformed}`,
        ),
      ).toBe(false);
    }
  });

  it("matches nothing against the dummy digest an unknown client is compared to", () => {
    expect(isClientSecretHash(UNMATCHABLE_SECRET_HASH)).toBe(true);
    expect(verifyClientSecret(generateClientSecret(), UNMATCHABLE_SECRET_HASH)).toBe(false);
    expect(verifyClientSecret("", UNMATCHABLE_SECRET_HASH)).toBe(false);
  });
});
