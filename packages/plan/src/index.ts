/**
 * Provider-neutral execution plans with a built-in Markdown implementation in
 * which **the Markdown document _is_ the plan**, not an export of one.
 *
 * The public surface is:
 *
 * - {@link PlanStore} — the provider data plane under one compare-and-swap contract.
 * - {@link PlanFactory} — settings-sensitive selection and owner-scoped store resolution.
 * - {@link PlanService} — the thin control-plane wrapper (list/read/setRetention/
 *   delete) the kernel exposes to clients.
 * - {@link decodePlanCursor} — the tag every paging cursor carries, so a cursor
 *   fed to a backend that did not mint it is a named {@link PlanCursorError}
 *   rather than a silent restart at page one.
 * - {@link parsePlan} and {@link renderPlan} — the Markdown ↔ {@link PlanDocument}
 *   codec. It is lenient on read and strict on write, and round-trips unknown
 *   frontmatter keys and extra `##` sections intact.
 * - {@link transitionTask} and {@link applyPlanRevision} — the pure task-status
 *   and structural-revision transforms.
 * - the Zod {@link planDocumentSchema | schemas} and their inferred types
 *   ({@link PlanDocument}, {@link PlanTask}, …).
 *
 * @packageDocumentation
 */
export { PLAN_CURSOR_TAGS, PlanCursorError, encodePlanCursor, decodePlanCursor } from "./cursor.ts";
export type { PlanCursorTag } from "./cursor.ts";
export { createFilePlanRepository } from "./file-repository.ts";
export type { CreateFilePlanRepositoryOptions } from "./file-repository.ts";
export {
  MAX_PLAN_DOCUMENT_BYTES,
  MAX_PLAN_LIST_PAGE_BYTES,
  MAX_PLAN_FRONTMATTER_BYTES,
  MAX_PLAN_DIRECTORY_ENTRIES,
  MAX_PLAN_FILENAME_WINDOW,
  MAX_PLAN_TASKS,
  MAX_PLAN_VALIDATION_ITEMS,
  MAX_PLAN_BATCH_OPERATIONS,
  MAX_PLAN_LOCATOR_CHARS,
  MAX_PLAN_TITLE_CHARS,
  MAX_PLAN_TASK_TITLE_CHARS,
  MAX_PLAN_SECTION_CHARS,
  MAX_PLAN_TASK_FIELD_CHARS,
  MAX_PLAN_ASSIGNEE_CHARS,
  MAX_PLAN_VALIDATION_ITEM_CHARS,
  MAX_PLAN_TEXT_CHARS,
  MAX_PLAN_EXTENSION_FIELDS,
  MAX_PLAN_EXTENSION_KEY_CHARS,
} from "./limits.ts";
export {
  digestText,
  specDigest,
  projectPlan,
  planFilename,
  parsePlan,
  renderPlan,
  newPlan,
} from "./format.ts";
export { planProviderConfigSchema } from "./provider-config.ts";
export type { PlanProviderConfig } from "./provider-config.ts";
export {
  PlanProviderUnavailableError,
  PlanProviderMismatchError,
  createPlanFactory,
} from "./provider.ts";
export type {
  PlanPluginPort,
  ResolvedPlanStore,
  PlanFactory,
  CreatePlanFactoryOptions,
} from "./provider.ts";
export {
  PlanNotFoundError,
  PlanConflictError,
  PlanSealedError,
  InvalidPlanError,
} from "./repository.ts";
export type {
  PlanIndex,
  PlanRecord,
  PlanRecordQuery,
  PlanRecordPage,
  PlanRepositoryTx,
  PlanRepository,
} from "./repository.ts";
export {
  planRevisionOperationSchema,
  nextRevision,
  applyPlanRevisions,
  applyPlanRevision,
} from "./revisions.ts";
export type { PlanRevisionOperation } from "./revisions.ts";
export {
  planStatusSchema,
  planRetentionSchema,
  DEFAULT_PLAN_RETENTION,
  planTaskStatusSchema,
  taskTitleSchema,
  singleLineSchema,
  planTaskSchema,
  planDocumentSchema,
  PLANS_CAPABILITY_NAME,
} from "./schemas.ts";
export type {
  PlanStatus,
  PlanRetention,
  PlanTaskStatus,
  PlanTask,
  PlanDocument,
  PlanRef,
} from "./schemas.ts";
export { PlanNotTerminalError, PlanService } from "./service.ts";
export { createPlanStore } from "./store.ts";
export type {
  PlanCas,
  PlanListInput,
  PlanListResult,
  CreatePlanInput,
  PlanStore,
  CreatePlanStoreOptions,
} from "./store.ts";
export {
  CREATE_PLAN_TOOL_NAME,
  READ_PLAN_TOOL_NAME,
  LIST_PLANS_TOOL_NAME,
  REVISE_PLAN_TOOL_NAME,
  TRANSITION_PLAN_TASK_TOOL_NAME,
  revisePlanInputSchema,
  planToolDefinitions,
} from "./tools.ts";
export {
  allowedTaskTransitions,
  transitionTask,
  CLOSED_TASK_STATUSES,
  isTaskClosed,
  canCompletePlan,
  isPlanSealed,
  sealedRevisionMessage,
  sealedTransitionMessage,
} from "./transitions.ts";
