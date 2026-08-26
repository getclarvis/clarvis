/**
 * The workflow layer's name for `@clarvis/capability`'s FIFO counting
 * semaphore, which bounds how many leaders run at once.
 *
 * @remarks The implementation was duplicated here, verbatim and untested, while
 * the engine's identical copy carried the tests. There is one implementation
 * now; these two names stay because the workflow context and the host's
 * workflow service are written in terms of them, and a leader bound is worth
 * naming for what it bounds.
 */
export { createSemaphore as createWorkflowSemaphore } from "@clarvis/capability";
export type { Semaphore as WorkflowSemaphore } from "@clarvis/capability";
