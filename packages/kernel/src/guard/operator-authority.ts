import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authorityEnvelopeSchema } from "./authority-schema.ts";
import {
  sanitizeText,
  type AuthorityEnvelopeV1,
  type OperatorAuthorityBinding,
  type OperatorAuthorityReader,
  type OperatorAuthoritySeed,
  type OperatorAuthorityState,
  type OperatorEvidence,
  type UserSteerContext,
} from "@clarvis/capability";

const identifier = z.string().min(1).max(256);
const bindingSchema = z
  .object({
    owner_key_name: identifier,
    session_id: identifier,
    controller_epoch: identifier,
    outcome_id: identifier.optional(),
  })
  .strict();
const evidenceSchema = z
  .object({
    id: identifier,
    source: z.enum(["start", "continue", "steer", "inherited"]),
    text: z.string().refine((text) => Buffer.byteLength(text, "utf8") <= 4096),
    execution_id: identifier,
    agent: z.enum(["lead", "subagent"]).optional(),
  })
  .strict();
const evidenceList = z
  .array(evidenceSchema)
  .max(32)
  .refine(
    (entries) =>
      entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.text, "utf8"), 0) <= 16384 &&
      new Set(entries.map((entry) => entry.id)).size === entries.length,
  );
const consumedSchema = z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(32);
const seedSchema = z
  .object({
    binding: bindingSchema,
    evidence: evidenceList,
    parent_run_id: identifier.optional(),
    ceiling: authorityEnvelopeSchema.optional(),
    consumed_effects: consumedSchema.optional(),
  })
  .strict()
  .refine((seed) =>
    seed.parent_run_id === undefined
      ? seed.ceiling === undefined && seed.evidence.every((entry) => entry.source !== "inherited")
      : seed.ceiling !== undefined && seed.evidence.every((entry) => entry.source === "inherited"),
  );

/** Validate the bounded host-to-guest seed without accepting fields from a public request. */
export function validOperatorAuthoritySeed(value: unknown): value is OperatorAuthoritySeed {
  return seedSchema.safeParse(value).success;
}

/** Match the complete host binding, including an absent outcome identity. */
function sameBinding(left: OperatorAuthorityBinding, right: OperatorAuthorityBinding): boolean {
  return (
    left.owner_key_name === right.owner_key_name &&
    left.session_id === right.session_id &&
    left.controller_epoch === right.controller_epoch &&
    left.outcome_id === right.outcome_id
  );
}

/** Internal compiler seam; never published through CapabilityServices or a package entry. */
const compilers = new WeakMap<
  OperatorAuthorityReader,
  (envelope: AuthorityEnvelopeV1) => boolean
>();
const consumers = new WeakMap<
  OperatorAuthorityReader,
  (revision: number, keys: string[]) => boolean
>();

/** Reserve bounded one-attempt effects before execution; failed execution does not refund authority. */
export function consumeAuthorityEffects(
  reader: OperatorAuthorityReader,
  revision: number,
  keys: string[],
): boolean {
  return consumers.get(reader)?.(revision, keys) ?? false;
}

/** Install only an envelope already validated by effect policy, fenced by the current revision. */
export function installAuthorityEnvelope(
  reader: OperatorAuthorityReader,
  envelope: AuthorityEnvelopeV1,
): boolean {
  return compilers.get(reader)?.(envelope) ?? false;
}

/**
 * Private host ledger. Overflow revokes rather than truncating away restrictions. Restoration
 * preserves bounded state; effect coverage is revalidated against the current registry at review.
 */
export function createOperatorAuthorityRuntime(input: {
  seed?: OperatorAuthoritySeed;
  prior?: OperatorAuthorityState;
  parent?: OperatorAuthorityReader;
  owner: string;
  executionId: string;
  signal?: AbortSignal;
}) {
  const parsed = seedSchema.safeParse(input.seed);
  const admitted = parsed.success && parsed.data.binding.owner_key_name === input.owner;
  const seed = admitted ? parsed.data : undefined;
  let state: OperatorAuthorityState = {
    version: 1,
    binding: seed?.binding ?? {
      owner_key_name: input.owner,
      session_id: input.executionId,
      controller_epoch: randomUUID(),
    },
    revision: 0,
    status: admitted ? "active" : "revoked",
    evidence: [],
    ...(seed?.ceiling === undefined
      ? {}
      : { ceiling: seed.ceiling, parent_run_id: seed.parent_run_id }),
    consumed_effects: seed?.consumed_effects ?? [],
  };
  const revoke = (): void => {
    if (state.status === "revoked") return;
    state = { ...state, status: "revoked", revision: state.revision + 1 };
    delete state.envelope;
  };
  const append = (entries: readonly OperatorEvidence[]): void => {
    if (state.status !== "active") return;
    const fresh = entries.filter((entry) => {
      const prior = state.evidence.find((value) => value.id === entry.id);
      if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(entry)) revoke();
      return prior === undefined;
    });
    if (state.status !== "active" || fresh.length === 0) return;
    const next = evidenceList.safeParse([...state.evidence, ...fresh]);
    if (!next.success) {
      revoke();
      return;
    }
    state = {
      ...state,
      revision: state.revision + 1,
      evidence: next.data.map((entry) => ({ ...entry, text: sanitizeText(entry.text) })),
    };
  };
  const prior = input.prior;
  if (
    seed !== undefined &&
    prior?.version === 1 &&
    prior.status === "active" &&
    bindingSchema.safeParse(prior.binding).success &&
    sameBinding(seed.binding, prior.binding) &&
    Number.isSafeInteger(prior.revision) &&
    prior.revision >= 0
  ) {
    const evidence = evidenceList.safeParse(prior.evidence);
    const envelope =
      prior.envelope === undefined ? undefined : authorityEnvelopeSchema.safeParse(prior.envelope);
    const consumed = consumedSchema.safeParse(prior.consumed_effects ?? []);
    if (evidence.success && consumed.success && (envelope === undefined || envelope.success))
      state = {
        ...state,
        revision: prior.revision,
        evidence: evidence.data,
        consumed_effects: consumed.data,
        ...(envelope?.success ? { envelope: envelope.data } : {}),
      };
    else revoke();
  }
  if (seed !== undefined) append(seed.evidence);
  const parentRevision = seed?.ceiling?.revision;
  const reader: OperatorAuthorityReader = Object.freeze({
    snapshot: () => {
      if (state.parent_run_id !== undefined) {
        const parent = input.parent?.snapshot();
        if (
          parent?.status !== "active" ||
          parent.revision !== parentRevision ||
          !sameBinding(parent.binding, state.binding)
        )
          revoke();
      }
      return structuredClone(state);
    },
  });
  compilers.set(reader, (envelope) => {
    if (reader.snapshot().status !== "active" || envelope.revision !== state.revision) return false;
    const previous = state.envelope;
    const changedOutcome =
      previous !== undefined &&
      JSON.stringify(previous.objectives.map((objective) => objective.id).sort()) !==
        JSON.stringify(envelope.objectives.map((objective) => objective.id).sort());
    if (changedOutcome) {
      const newest = state.evidence.at(-1)?.id;
      if (
        state.revision <= previous.revision ||
        state.parent_run_id !== undefined ||
        newest === undefined ||
        envelope.grants.some((grant) => !grant.evidence_ids.includes(newest)) ||
        envelope.objectives.some((objective) => !objective.evidence_ids.includes(newest))
      )
        return false;
      state = {
        ...state,
        revision: state.revision + 1,
        binding: { ...state.binding, outcome_id: randomUUID() },
      };
    }
    state = { ...state, envelope: { ...structuredClone(envelope), revision: state.revision } };
    return true;
  });
  consumers.set(reader, (revision, keys) => {
    if (reader.snapshot().status !== "active" || state.revision !== revision) return false;
    const consumed = state.consumed_effects ?? [];
    if (new Set(keys).size !== keys.length || keys.some((key) => consumed.includes(key)))
      return false;
    const next = consumedSchema.safeParse([...consumed, ...keys]);
    if (!next.success) {
      revoke();
      return false;
    }
    state = { ...state, consumed_effects: next.data };
    return true;
  });
  const seenSteers = new Set<string>();
  const onSteer = (context: UserSteerContext): void => {
    if (context.id !== undefined && seenSteers.has(context.id)) return;
    if (context.id !== undefined) seenSteers.add(context.id);
    append([
      {
        id: randomUUID(),
        source: "steer",
        text: context.message,
        execution_id: input.executionId,
      },
    ]);
  };
  if (input.signal?.aborted) revoke();
  else input.signal?.addEventListener("abort", revoke, { once: true });
  return {
    reader,
    onSteer,
    finalize(outcome: {
      status: string;
      disposition?: "final" | "checkpoint";
    }): OperatorAuthorityState {
      input.signal?.removeEventListener("abort", revoke);
      if (outcome.status !== "completed") revoke();
      else if (outcome.disposition !== "checkpoint" && state.status === "active") {
        state = { ...state, status: "settled", revision: state.revision + 1 };
        delete state.envelope;
      }
      return structuredClone(state);
    },
  };
}
