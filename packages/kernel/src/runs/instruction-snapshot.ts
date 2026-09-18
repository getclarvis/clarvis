import { createHash } from "node:crypto";
import type { OperatorAuthoritySeed, OperatorInstructions } from "@clarvis/capability";
import type { ContextRecord } from "../config/config-store.ts";

const snapshots = new WeakMap<object, readonly OperatorInstructions[]>();

/** Read a detached host snapshot without accepting instruction fields from request JSON. */
export function readRunInstructions(body: unknown): readonly OperatorInstructions[] {
  if (typeof body !== "object" || body === null) return [];
  return structuredClone(snapshots.get(body) ?? []);
}

/** Bind the exact assembled context through an internal identity, never a public JSON field. */
export function captureRunInstructions<T extends object>(
  body: T,
  contexts: readonly ContextRecord[],
): T {
  const instructions = contexts.map(({ scope, path, content }) => {
    const source = path?.replaceAll("\\", "/").split("/").at(-1) ?? scope;
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    return { id: `instructions:${scope}:${digest}`, scope, source, digest, content };
  });
  snapshots.set(body, structuredClone(instructions));
  return body;
}

/** Preserve host provenance when preparation clones or constrains an assembled request. */
export function transferRunInstructions(source: unknown, target: unknown): void {
  if (
    typeof source !== "object" ||
    source === null ||
    typeof target !== "object" ||
    target === null
  )
    return;
  const snapshot = snapshots.get(source);
  if (snapshot !== undefined) snapshots.set(target, snapshot);
}

/** Add only instructions captured by the trusted assembler; caller-shaped fields are ignored. */
export function seedRunInstructions(
  seed: OperatorAuthoritySeed | undefined,
  body: unknown,
): OperatorAuthoritySeed | undefined {
  if (seed === undefined || typeof body !== "object" || body === null) return seed;
  const instructions = snapshots.get(body);
  return instructions === undefined
    ? seed
    : { ...seed, instructions: structuredClone(instructions) };
}
