import type {
  CapabilityGrantDeclaration,
  CapabilityRegistry,
  RunRequest,
} from "@clarvis/capability";
import { ValidationError } from "@clarvis/capability";

/** Grants whose implementation is owned by the engine itself. */
const BUILTIN_GRANT_DECLARATIONS = [
  { name: "ask_user" },
  { name: "read_workspace" },
  { name: "edit_workspace" },
  { name: "run_commands" },
] as const satisfies readonly CapabilityGrantDeclaration[];

/** Built-in names retained on `grantSchema.options` for static UI discovery. */
export const BUILTIN_GRANT_NAMES = BUILTIN_GRANT_DECLARATIONS.map(
  (declaration) => declaration.name,
);

/** Reject profile grants neither owned by the engine nor declared by a capability. */
export function requireKnownGrants(
  data: Pick<RunRequest, "profiles">,
  registry?: CapabilityRegistry,
): void {
  const known = new Set([
    ...BUILTIN_GRANT_NAMES,
    ...(registry?.grants() ?? []).map((declaration) => declaration.name),
  ]);
  for (const profile of data.profiles) {
    for (const grant of profile.grants ?? []) {
      if (known.has(grant)) continue;
      throw new ValidationError(
        "invalid_profile",
        `profile '${profile.name}'.grants contains undeclared grant '${grant}'.`,
        { name: profile.name, grant },
      );
    }
  }
}
