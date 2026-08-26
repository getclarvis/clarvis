import { randomBytes } from "node:crypto";

let counter = 0;

/**
 * Mint a token unique within and across processes, suitable for temp-file
 * suffixes and other collision-prone names.
 *
 * @returns a string combining the pid, the current epoch millis, a
 *   monotonically increasing in-process counter, and 6 random bytes, so two
 *   calls never collide even within the same millisecond.
 */
export function uniqueToken(): string {
  return `${process.pid}-${Date.now()}-${counter++}-${randomBytes(6).toString("hex")}`;
}
