import type { ReviewedEffectClass, ReviewedEffectInference } from "@clarvis/capability";
import type { GuardEffectDescriptor } from "./types.ts";

const BUILTINS: ReadonlyArray<readonly [string, ReviewedEffectClass, ReviewedEffectInference]> = [
  ["workspace.inspect", "read", "bounded"],
  ["workspace.content.write", "local_mutation", "bounded"],
  ["process.execute", "unknown", "human_only"],
  ["environment.temporary_root", "local_mutation", "bounded"],
  ["value.literal_data", "read", "bounded"],
  ["clarvis.authoring.write", "local_mutation", "bounded"],
  ["clarvis.operational_config.write", "authority_change", "explicit"],
  ["git.commit", "local_mutation", "bounded"],
  ["git.push", "external_mutation", "explicit"],
  ["git.history_rewrite", "destructive", "human_only"],
  ["github.pr.open_or_update", "external_mutation", "explicit"],
  ["github.pr.merge", "external_mutation", "human_only"],
  ["github.checks.observe", "external_observation", "bounded"],
  ["github.actions.rerun_failed", "external_mutation", "bounded"],
  ["github.actions.rerun_all", "external_mutation", "human_only"],
  ["github.actions.dispatch", "external_mutation", "human_only"],
  ["release.publish", "external_mutation", "human_only"],
  ["deploy.publish", "external_mutation", "human_only"],
  ["credential.access", "credential", "human_only"],
  ["destructive.delete", "destructive", "human_only"],
  ["external.unknown", "unknown", "human_only"],
];

/** Closed constraint vocabulary; unknown keys never disappear during validation. */
function validConstraints(id: string, value: Record<string, string | number | boolean>): boolean {
  if (
    id === "clarvis.authoring.write" &&
    Object.keys(value).length === 1 &&
    typeof value.path_digest === "string"
  )
    return /^[a-f0-9]{64}$/.test(value.path_digest);
  const keys =
    id === "github.actions.rerun_failed"
      ? ["failed_only", "attempts", "head_sha", "run_id"]
      : id === "environment.temporary_root"
        ? ["root"]
        : id === "value.literal_data"
          ? ["bytes"]
          : id === "git.commit"
            ? ["head_sha"]
            : [
                  "clarvis.authoring.write",
                  "clarvis.operational_config.write",
                  "destructive.delete",
                ].includes(id)
              ? ["expected_revision", "next_revision", "bytes"]
              : [];
  if (Object.keys(value).some((key) => !keys.includes(key))) return false;
  if (
    Object.values(value).some((item) =>
      typeof item === "string"
        ? item.length > 256
        : typeof item === "number" && (!Number.isSafeInteger(item) || item < 0),
    )
  )
    return false;
  if (id === "github.actions.rerun_failed")
    return (
      value.failed_only === true &&
      value.attempts === 1 &&
      typeof value.head_sha === "string" &&
      /^[a-f0-9]{40,64}$/.test(value.head_sha) &&
      typeof value.run_id === "string" &&
      /^[0-9]+$/.test(value.run_id)
    );
  if (id === "environment.temporary_root") return typeof value.root === "string";
  if (id === "value.literal_data") return typeof value.bytes === "number" && value.bytes <= 4096;
  if (id === "git.commit")
    return typeof value.head_sha === "string" && /^[a-f0-9]{40,64}$/.test(value.head_sha);
  if (
    ["clarvis.authoring.write", "clarvis.operational_config.write", "destructive.delete"].includes(
      id,
    )
  )
    return (
      typeof value.expected_revision === "string" &&
      /^(?:absent|[a-f0-9]{64})$/.test(value.expected_revision) &&
      typeof value.next_revision === "string" &&
      /^(?:absent|[a-f0-9]{64})$/.test(value.next_revision) &&
      typeof value.bytes === "number" &&
      value.bytes <= 262144
    );
  return true;
}

/** Registry cannot be mutated after composition; workspace configuration never registers effects. */
export function createGuardEffectRegistry(additional: readonly GuardEffectDescriptor[] = []) {
  const descriptors = new Map<string, GuardEffectDescriptor>();
  for (const [id, effectClass, inference] of BUILTINS) {
    descriptors.set(
      id,
      Object.freeze<GuardEffectDescriptor>({
        id,
        class: effectClass,
        inference,
        validateConstraints: (value) => validConstraints(id, value),
        covers(grant, fact) {
          return (
            inference !== "human_only" &&
            fact.id === id &&
            grant.effect_id === id &&
            fact.class === effectClass &&
            fact.inference === inference &&
            fact.attestation === "complete" &&
            fact.reviewability !== "human_only" &&
            fact.target !== undefined &&
            grant.target_digests.includes(fact.target.digest) &&
            (grant.relation === "direct" || inference === "bounded") &&
            validConstraints(id, grant.constraints) &&
            validConstraints(id, fact.constraints) &&
            Object.entries(fact.constraints).every(
              ([key, value]) => grant.constraints[key] === value,
            ) &&
            Object.entries(grant.constraints).every(
              ([key, value]) => fact.constraints[key] === value,
            )
          );
        },
      }),
    );
  }
  for (const descriptor of additional) {
    if (descriptors.has(descriptor.id)) throw new Error("effect descriptor cannot be replaced");
    descriptors.set(descriptor.id, Object.freeze({ ...descriptor }));
  }
  return Object.freeze({
    get: (id: string) => descriptors.get(id),
    list: () => [...descriptors.values()],
  });
}

/** Registry port consumed only by host review services. */
export type GuardEffectRegistry = ReturnType<typeof createGuardEffectRegistry>;
