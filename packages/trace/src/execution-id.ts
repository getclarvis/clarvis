import { randomUUID } from "node:crypto";

/**
 * Mint a fresh, collision-resistant execution id of the form `exec_<uuid>`.
 *
 * @returns a new execution id built from a random v4 UUID, prefixed `exec_`.
 */
export function generateExecutionId(): string {
  return `exec_${randomUUID()}`;
}
