/**
 * The FIFO counting semaphore the runtime bounds its sub-agent fan-out with.
 *
 * @remarks The implementation lives in `@clarvis/capability`: it is pure
 * computation over promises with no engine type in its signature, and the
 * workflow layer bounds its leader fan-out with the very same one. This module
 * stays as the runtime's name for it, so `./support` and every direct importer
 * keep one import path.
 */
export { createSemaphore, type Semaphore } from "@clarvis/capability";
