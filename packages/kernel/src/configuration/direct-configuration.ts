import { createConfigurationReview } from "./review.ts";
import type { Logger } from "@clarvis/capability";
import type { ExtensionProfileSkillRef } from "@clarvis/protocol";
import type { PreparedSkillInclusion } from "../extension-profiles/extension-profile-manager.ts";
import type { ConfigurationRoot } from "@clarvis/paths";
import { join } from "node:path";
import type { ConfigStore } from "../config/config-store.ts";
import { createConfigurationCapability } from "./capability.ts";
import {
  configurationFileMutationFacts,
  configurationFileOperation,
  configurationSkillRef,
} from "./files.ts";

/** Host-installed restricted writer; editable profiles cannot install or widen this capability. */
export function createDirectConfigurationCapability(options: {
  roots: Readonly<Record<ConfigurationRoot, string>>;
  store: ConfigStore;
  enabled: boolean;
  audit?: Logger;
  changed?(path: string): void;
  prepareSkillInclusion?(ref: ExtensionProfileSkillRef): PreparedSkillInclusion | undefined;
}) {
  return createConfigurationCapability({
    roots: options.roots,
    bind(ctx) {
      const ceiling = ctx.env.CLARVIS_AGENT_TOOLS_MAX_GRANT;
      if (
        !options.enabled ||
        !ctx.env.CLARVIS_AGENT_TOOLS_ENABLED ||
        (ceiling !== "edit" && ceiling !== "exec") ||
        !ctx.entryGrants.some((grant) => grant === "edit_workspace" || grant === "run_commands")
      )
        return null;
      const settings = options.store.readSettings().merged;
      if (settings.runtime?.backend === "docker" || settings.runtime?.backend === "podman")
        return null;
      const reviewEffect = createConfigurationReview(ctx, options);
      return async (input) => {
        const request = structuredClone(input);
        ctx.signal?.throwIfAborted();
        const preview = configurationFileMutationFacts(options.roots, request);
        if (preview === undefined) return configurationFileOperation(options.roots, request);
        const skillRef =
          request.operation === "write" &&
          preview.expectedRevision === null &&
          request.content !== undefined
            ? configurationSkillRef(options.roots, request.root, request.path, request.content)
            : undefined;
        const inclusion =
          skillRef === undefined ? undefined : options.prepareSkillInclusion?.(skillRef);
        const before = configurationFileOperation(options.roots, { ...request, operation: "read" });
        await reviewEffect(
          [preview, ...(inclusion?.facts ?? [])],
          { request, before, ...(inclusion === undefined ? {} : { membership: inclusion.review }) },
          `Review configuration ${request.operation}: ${preview.canonicalPath}\n\nExpected revision: ${preview.expectedRevision ?? "absent"}\n\n` +
            (request.operation === "write"
              ? (request.content ?? "")
              : request.operation === "edit"
                ? `Replace:\n${request.old_text ?? ""}\nWith:\n${request.new_text ?? ""}`
                : "Delete the captured file.") +
            (inclusion === undefined
              ? ""
              : `\n\nInclude this skill in the current environment:\n${JSON.stringify(inclusion.review, null, 2)}`),
        );
        const path = join(options.roots[request.root], ...request.path.split("/"));
        const mutate = () => configurationFileOperation(options.roots, request);
        const write = () => (inclusion === undefined ? mutate() : inclusion.apply(mutate));
        const result =
          request.root.startsWith("workspace_") && options.store.withOperatorWrite
            ? options.store.withOperatorWrite("workspace", write, () => ({
                path,
                expectedRevision: preview.nextRevision,
              }))
            : write();
        options.changed?.(path);
        if (request.path.startsWith("skills/"))
          return {
            ...(result as Record<string, unknown>),
            application: "pending",
            message:
              "Saved. The skill catalog refreshes automatically after runs using the captured revision settle. " +
              "The current turn retains its catalog. Use the skill in a subsequent turn; no activation approval or reload is required.",
          };
        return result;
      };
    },
  });
}
