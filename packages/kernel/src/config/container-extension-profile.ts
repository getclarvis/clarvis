import type { ExtensionProfileService, ResolvedExtensionProfile } from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import { digestContainerJson } from "./container-projection-json.ts";

/** Process policy identity, independent of artifact, workspace, credentials and operator settings. */
const fingerprint = digestContainerJson({
  schemaVersion: 1,
  plugins: false,
  skills: false,
  hooks: false,
  mcp: false,
  tasks: false,
  externalCapabilityProviders: false,
});

/**
 * The guest's only Extension Profile. Reads are in-memory defensive snapshots; no inventory,
 * installed extension, workspace configuration or manager is discovered or constructed.
 * Native run preparation can pin current() while every selection and mutation stays unsupported.
 */
export function createContainerExtensionProfileService(): ExtensionProfileService {
  const current: ResolvedExtensionProfile = {
    id: "builtin:container",
    ref: { scope: "builtin", name: "container" },
    immutable: true,
    status: "ready",
    fingerprint,
    selection_origin: "builtin",
    definition: { schema_version: 1, plugins: [], skills: [] },
    plugins: [],
    standalone_skills: [],
    issues: [],
    counts: {
      plugins_active: 0,
      standalone_skills_active: 0,
      plugin_skills_active: 0,
      mcp_servers_active: 0,
      hooks_declared: 0,
    },
  };
  const denied = async (): Promise<never> => {
    throw kernelError("unsupported", "Container Extension Profile is immutable");
  };
  return {
    current: async () => structuredClone(current),
    list: async () => [
      {
        ref: structuredClone(current.ref),
        immutable: true,
        definition: structuredClone(current.definition!),
      },
    ],
    get: async (ref) => {
      if (ref.scope !== "builtin" || ref.name !== "container") {
        throw kernelError("not_found", "Container Extension Profile was not found");
      }
      return structuredClone(current);
    },
    inventory: async () => ({ plugins: [], standalone_skills: [] }),
    preview: denied,
    previewClear: denied,
    previewComposition: denied,
    select: denied,
    clearSelection: denied,
    applyComposition: denied,
    create: denied,
    update: denied,
    delete: denied,
    clone: denied,
  };
}
