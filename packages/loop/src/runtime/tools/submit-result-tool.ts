import type { NamespacedTool } from "@clarvis/capability";

import { SUBMIT_RESULT_TOOL_NAME } from "./wire-names.ts";

export { SUBMIT_RESULT_TOOL_NAME };

/**
 * Build the `submit_result` {@link NamespacedTool} whose input schema is the run's
 * `output_schema`; acceptance also requires the run's finalization gates to pass.
 *
 * @param outputSchema - the JSON Schema the submitted result object must satisfy.
 * @returns the tool descriptor advertised to the model.
 */
export function buildSubmitResultTool(outputSchema: Record<string, unknown>): NamespacedTool {
  return {
    fullName: SUBMIT_RESULT_TOOL_NAME,
    wireName: SUBMIT_RESULT_TOOL_NAME,
    mcpName: "",
    toolName: SUBMIT_RESULT_TOOL_NAME,
    description:
      "Submit the completed result matching this schema. An accepted submission ends the run. " +
      "If validation or a runtime gate rejects it, follow the returned guidance before retrying; " +
      "a rejected submission is not completion.",
    inputSchema: outputSchema,
  };
}
