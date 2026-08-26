import { existsSync } from "node:fs";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import { writeFileDurableSync } from "@clarvis/paths";
import { z } from "zod";
import { readBoundedUtf8Sync } from "./bounded-file.ts";

const MAX_SIGNING_KEY_FILE_BYTES = 64 * 1024;

/** The JOSE algorithm this server signs with. */
export const SIGNING_ALG = "EdDSA";

/** The signing key, plus the public half a verifier needs. */
export interface SigningKey {
  /** RFC 7638 thumbprint of the public key, carried in every token header. */
  readonly kid: string;
  readonly alg: typeof SIGNING_ALG;
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  /** The public JWK, as published at the JWKS endpoint. */
  readonly publicJwk: JWK;
}

/** The stored key file: an Ed25519 private JWK. */
const keyFileSchema = z.object({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: z.string().min(1),
  d: z.string().min(1),
  kid: z.string().min(1).optional(),
});

/** Default file name for the signing key inside the config directory. */
export const SIGNING_KEY_FILE = "auth-key.json";

/** Build a {@link SigningKey} from a private JWK. */
async function fromJwk(jwk: z.infer<typeof keyFileSchema>): Promise<SigningKey> {
  const publicJwkBase: JWK = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
  const kid = jwk.kid ?? (await calculateJwkThumbprint(publicJwkBase));
  const privateKey = (await importJWK({ ...jwk, alg: SIGNING_ALG }, SIGNING_ALG)) as CryptoKey;
  const publicKey = (await importJWK(
    { ...publicJwkBase, alg: SIGNING_ALG },
    SIGNING_ALG,
  )) as CryptoKey;
  return {
    kid,
    alg: SIGNING_ALG,
    privateKey,
    publicKey,
    publicJwk: { ...publicJwkBase, alg: SIGNING_ALG, kid, use: "sig" },
  };
}

/**
 * Load the server's signing key, generating it on first boot.
 *
 * @param file - the absolute path the key is persisted at.
 * @returns the loaded or freshly generated {@link SigningKey}.
 * @throws {@link Error} when the file exists but is not a valid Ed25519 private
 *   JWK. It is never regenerated over a broken file: silently minting a new key
 *   would invalidate every outstanding token and look like a transient outage.
 * @remarks The key is persisted rather than held in memory so a restart does not
 *   invalidate tokens the server already issued. It is written with the same
 *   `0600` file / `0700` directory posture as `keys.json`, via
 *   {@link writeFileDurableSync}, whose temp name is unique per writer — two
 *   boots racing this file no longer collide on one shared temp path.
 */
export async function loadOrCreateSigningKey(file: string): Promise<SigningKey> {
  if (existsSync(file)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readBoundedUtf8Sync(file, MAX_SIGNING_KEY_FILE_BYTES));
    } catch {
      throw new Error(`signing key at ${file} is not valid JSON`);
    }
    const parsed = keyFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`signing key at ${file} is not a valid Ed25519 private JWK`);
    }
    return fromJwk(parsed.data);
  }

  const { privateKey, publicKey } = await generateKeyPair(SIGNING_ALG, {
    crv: "Ed25519",
    extractable: true,
  });
  const priv = await exportJWK(privateKey);
  const pub = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(pub);
  const stored = { kty: "OKP", crv: "Ed25519", x: pub.x, d: priv.d, kid };

  writeFileDurableSync(file, `${JSON.stringify(stored, null, 2)}\n`);

  return fromJwk(keyFileSchema.parse(stored));
}

/** The JWKS document published for this key. */
export function jwks(key: SigningKey): { keys: JWK[] } {
  return { keys: [key.publicJwk] };
}
