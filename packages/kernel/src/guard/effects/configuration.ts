import type { ConfigurationRoot } from "@clarvis/paths";
import type { GuardEffectRegistry } from "./registry.ts";
import { effectDigest, effectFact } from "./facts.ts";
import type { GuardEffectFact } from "./types.ts";

/** Writer-produced facts after path, schema, revision and content validation; never raw tool args. */
export interface ConfigurationMutationFacts {
  canonicalPath: string;
  root: ConfigurationRoot;
  expectedRevision: string | null;
  nextRevision: string | null;
  bytes: number;
  surface: "authoring" | "operational" | "delete";
}

/** The restricted writer and shell guard use the same immutable descriptor vocabulary. */
export function attestConfiguration(
  input: ConfigurationMutationFacts,
  registry: GuardEffectRegistry,
): GuardEffectFact {
  const id =
    input.surface === "authoring"
      ? "clarvis.authoring.write"
      : input.surface === "delete"
        ? "destructive.delete"
        : "clarvis.operational_config.write";
  return effectFact(
    { registry, environment: {} },
    id,
    {
      kind: "external_resource",
      digest: effectDigest(input.root, input.canonicalPath),
      state_digest: effectDigest(input.expectedRevision ?? "absent"),
    },
    {
      expected_revision: input.expectedRevision ?? "absent",
      next_revision: input.nextRevision ?? "absent",
      bytes: input.bytes,
    },
    true,
  );
}
