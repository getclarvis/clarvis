import type { ConfigurationRoot } from "@clarvis/paths";
import type { GuardEffectRegistry } from "./registry.ts";
import { effectDigest, effectFact } from "./facts.ts";
import type { GuardEffectFact } from "./types.ts";

/** Writer-produced facts after path, schema, revision and content validation; never raw tool args. */
export interface ConfigurationMutationFacts {
  canonicalPath: string;
  root: ConfigurationRoot | "workspace";
  expectedRevision: string | null;
  nextRevision: string | null;
  bytes: number;
  operation: "write" | "edit" | "delete";
  fieldClass: string;
  surface: "workspace" | "authoring" | "authoring_delete" | "operational" | "delete" | "tree";
  environmentDigest?: string;
}

/** The restricted writer and shell guard use the same immutable descriptor vocabulary. */
export function attestConfiguration(
  input: ConfigurationMutationFacts,
  registry: GuardEffectRegistry,
): GuardEffectFact {
  const id =
    input.surface === "workspace"
      ? "workspace.content.write"
      : input.surface === "tree"
        ? "workspace.tree.delete"
        : input.surface === "authoring"
          ? "clarvis.authoring.write"
          : input.surface === "authoring_delete"
            ? "clarvis.authoring.delete"
            : input.surface === "delete"
              ? "destructive.delete"
              : "clarvis.operational_config.write";
  return effectFact(
    registry,
    id,
    {
      kind: "external_resource",
      digest: effectDigest(input.root, input.canonicalPath),
      state_digest: effectDigest(input.expectedRevision ?? "absent"),
      labels: { root: input.root, path: input.canonicalPath },
    },
    {
      expected_revision: input.expectedRevision ?? "absent",
      next_revision: input.nextRevision ?? "absent",
      bytes: input.bytes,
      operation: input.operation,
      field_class: input.fieldClass,
      diff_digest: effectDigest(input.expectedRevision ?? "absent", input.nextRevision ?? "absent"),
      ...(input.environmentDigest === undefined
        ? {}
        : { environment_digest: input.environmentDigest }),
    },
    true,
  );
}
