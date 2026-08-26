import type { NamespacedTool } from "@clarvis/capability";

import { SUBMIT_RESULT_TOOL_NAME } from "./wire-names.ts";

export { SUBMIT_RESULT_TOOL_NAME };

/**
 * Build the `submit_result` {@link NamespacedTool} whose input schema is the run's
 * `output_schema`, so calling it with valid arguments finalizes the run.
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
      "Finalize the run by submitting the final answer. Call this exactly once, with " +
      "arguments conforming to the schema. Calling it with valid arguments ends the run; " +
      "the submitted object becomes the run result. If a call is rejected for not matching " +
      "the schema, correct the arguments and call it again.",
    inputSchema: outputSchema,
  };
}
