import { createHash, timingSafeEqual } from "node:crypto";

/** Prefix marking the digest scheme stored in `auth.json`. */
export const SECRET_HASH_PREFIX = "sha256:";

/**
 * Shortest secret an operator may supply to {@link hashClientSecret}.
 *
 * @remarks A floor, not a strength check — a caller who types 32 predictable
 * characters is still weak. It exists because the stored digest is fast by
 * design (see {@link hashClientSecret}), which puts the entire offline-attack
 * burden on the secret's own entropy. {@link generateClientSecret} is the
 * supported path and clears this by a wide margin.
 */
export const MIN_CLIENT_SECRET_LENGTH = 32;

/**
 * Mint a client secret.
 *
 * @returns 32 bytes of CSPRNG output, base64url-encoded.
 * @remarks A client secret is never typed by a human — it lives in the calling
 * application's own configuration — so there is no reason for it to be
 * guessable, and 256 bits is what lets the stored digest be a fast one.
 */
export function generateClientSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Hash a client secret for storage in `auth.json`.
 *
 * @param secret - the plaintext secret; at least {@link MIN_CLIENT_SECRET_LENGTH}
 *   characters.
 * @returns the digest, as `sha256:<base64url>`.
 * @throws {@link Error} when the secret is shorter than the floor.
 * @remarks **A plain SHA-256, deliberately, and not a password KDF.** argon2 and
 * bcrypt exist to buy time against an offline attack on a *human-chosen* secret;
 * against the 256 bits {@link generateClientSecret} emits they buy nothing, because
 * the search space already defeats the attack. What they do buy is a verification
 * expensive enough to be a memory-amplification vector on an unauthenticated
 * endpoint — which then needs an attempt budget to contain, which in turn lets
 * anyone who learns a `client_id` throttle the real client by spending that
 * budget. Making verification cheap removes the vector, the budget's reason to
 * refuse, and that lockout together. It is how an API key is stored everywhere
 * else, for the same reason.
 *
 *   The cost of the choice is that the secret's entropy is now the *only* thing
 *   standing between a leaked `auth.json` and a usable credential.
 */
export function hashClientSecret(secret: string): string {
  if (secret.length < MIN_CLIENT_SECRET_LENGTH) {
    throw new Error(
      `a client secret must be at least ${MIN_CLIENT_SECRET_LENGTH} characters; the stored digest ` +
        "is a fast one, so the secret's own entropy is what resists an offline attack. Run " +
        "`clarvis-server hash-secret` with no argument to generate one.",
    );
  }
  return `${SECRET_HASH_PREFIX}${createHash("sha256").update(secret, "utf8").digest("base64url")}`;
}

/** Whether a stored value is a digest this module can verify. */
export function isClientSecretHash(value: string): boolean {
  if (!value.startsWith(SECRET_HASH_PREFIX)) return false;
  const encoded = value.slice(SECRET_HASH_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return false;
  const decoded = Buffer.from(encoded, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === encoded;
}

/**
 * Check a presented secret against a stored digest.
 *
 * @param secret - the secret the caller presented.
 * @param stored - the `sha256:<base64url>` digest from `auth.json`.
 * @returns whether they match.
 * @remarks Compared with {@link timingSafeEqual} over the raw digests. Both sides
 * are 32 bytes whatever the inputs were, so the comparison never reveals a
 * length and never returns early on the first differing byte.
 */
export function verifyClientSecret(secret: string, stored: string): boolean {
  if (!isClientSecretHash(stored)) return false;
  const expected = Buffer.from(stored.slice(SECRET_HASH_PREFIX.length), "base64url");
  const actual = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(expected, actual);
}

/**
 * A digest no secret will ever match, for spending the same work on an unknown
 * client as on a wrong one.
 *
 * @remarks Skipping the comparison for an unknown `client_id` would leave a
 * timing oracle enumerating the enrolment table. It is a module constant rather
 * than a lazily-awaited value: there is nothing expensive to defer, and the
 * absence of that `await` is what leaves no window between checking a limit and
 * spending it.
 */
export const UNMATCHABLE_SECRET_HASH = `${SECRET_HASH_PREFIX}${Buffer.alloc(32).toString("base64url")}`;
