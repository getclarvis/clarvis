/**
 * SecretService — API keys / provider secrets stored server-side.
 *
 * Values only ever flow client → kernel; listing returns names, never values. The
 * kernel injects secrets into runs itself, so the UI no longer builds a spawn env.
 *
 * @remarks
 * Secrets travel over the transport on `set`. That is fine over local stdio (same
 * user/host); a hosted kernel needs TLS plus at-rest protection.
 */

/** Server-side secret store (names only on read). */
export interface SecretService {
  /** List configured secret names (never values). */
  listNames(): Promise<string[]>;

  /**
   * Create or overwrite a secret value.
   *
   * @param name - Secret key name.
   * @param value - Secret value (sent to the kernel; not retained by the client).
   */
  set(name: string, value: string): Promise<void>;

  /**
   * Remove a secret by name.
   *
   * @param name - Secret key name.
   */
  delete(name: string): Promise<void>;
}
