/**
 * Absolute workflow-shape ceilings shared by authored artifacts, tool schemas,
 * result schemas and the programmatic parsers behind those schemas.
 *
 * @remarks These are product safety bounds, not tuning knobs. A workflow is
 * multiplied across rounds, selected items, replicas and repeat passes, so an
 * unbounded value in any one dimension can allocate the complete dispatch graph
 * before the supervision registry gets a chance to refuse it. Keep every wire
 * and file boundary on these same constants so validation cannot drift.
 */
export const WORKFLOW_LIMITS = Object.freeze({
  /** Rounds in one workflow or `run_round` call. */
  rounds: 16,
  /** Independent replicas of one selected item. */
  fanout: 8,
  /** Round ids participating in one repeat block. */
  repeatRounds: 16,
  /** Dedupe fields in one repeat block. */
  repeatDedupeFields: 16,
  /** Total repeat passes after the initial sequence. */
  repeatMaxRounds: 8,
  /** Consecutive dry passes that may be requested. */
  repeatDryRounds: 8,
  /** Work items, or other array members selected into a later round. */
  workItems: 64,
  /** File declarations carried by one work item. */
  filesPerWorkItem: 64,
  /** Dependency declarations carried by one work item. */
  dependenciesPerWorkItem: 64,
  /** Generic evidence/finding/unknown arrays in shipped result schemas. */
  resultItems: 64,
  /** Declared workflow argument names / tool argument properties. */
  args: 64,
  /** Names, ids, profiles, field names and other compact identifiers. */
  identifierChars: 256,
  /** Paths declared by work items or workflow artifacts. */
  pathChars: 1_024,
  /** Prompts, briefs, descriptions, evidence and other prose values. */
  textChars: 32_768,
  /** Maximum UTF-8 bytes read for a WORKFLOW.md document. */
  artifactBytes: 262_144,
  /** Maximum UTF-8 bytes read for one external round brief. */
  briefBytes: 131_072,
  /** Workflow roots accepted by one catalogue scan. */
  catalogRoots: 16,
  /** Directory entries examined across all roots by one catalogue scan. */
  catalogEntries: 2_048,
  /** Workflow directories admitted across all roots by one catalogue scan. */
  catalogWorkflows: 256,
  /** Aggregate workflow-document and brief bytes admitted by one catalogue scan. */
  catalogSourceBytes: 16 * 1024 * 1024,
});

/** True when a value is a string whose retained representation is bounded. */
export function isBoundedWorkflowString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}
