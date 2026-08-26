import { NOOP_LOGGER } from "./log.ts";
import type { Logger } from "./ports.ts";
import { sanitizeErrorMessage } from "./sanitize.ts";

/** Default process/host ceiling for physical extension calls outside run-end work. */
export const DEFAULT_MAX_ACTIVE_EXTENSION_CALLS = 32;
/** Independent reserve for finalizers and run-end observers. */
export const DEFAULT_MAX_ACTIVE_EXTENSION_RUN_END_CALLS = 8;
/** One faulty operation cannot consume its whole class by itself. */
export const DEFAULT_MAX_ACTIVE_EXTENSION_CALLS_PER_OPERATION = 4;

export type ExtensionCallClass = "normal" | "run_end";
export type ExtensionCallUnavailableReason = "operation_busy" | "capacity_full" | "closed";

export interface ExtensionAdmissionSnapshot {
  state: "open" | "closed";
  active: number;
  activeNormal: number;
  activeRunEnd: number;
  maxActiveNormal: number;
  maxActiveRunEnd: number;
  maxActivePerOperation: number;
}

export interface ExtensionAdmissionOptions {
  maxActiveNormal?: number;
  maxActiveRunEnd?: number;
  maxActivePerOperation?: number;
  onStateChange?: (snapshot: ExtensionAdmissionSnapshot) => void;
  /**
   * Where refusals are reported; defaults to {@link NOOP_LOGGER}.
   *
   * @remarks A refusal is returned to the caller as an exception class and
   *   nothing else, so saturation — every slot legitimately busy — and one
   *   operation stuck forever produce the identical symptom. The counts on
   *   `capability.extension_permit_refused` are what separate them.
   */
  logger?: Logger;
}

export class ExtensionCallUnavailableError extends Error {
  override readonly name = "ExtensionCallUnavailableError";

  constructor(
    readonly operation: string,
    readonly reason: ExtensionCallUnavailableReason,
  ) {
    super(
      reason === "operation_busy"
        ? `Extension operation '${operation}' already has too many physical calls in flight.`
        : reason === "capacity_full"
          ? "The host extension-call capacity is full."
          : "The host extension-call admission controller is closed.",
    );
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return resolved;
}

/**
 * Host-owned admission for physical capability/lifecycle invocations.
 *
 * @remarks A permit belongs to the promise returned by extension code, not to
 * the caller's timeout race. If that code ignores cancellation and never
 * settles, its permit stays occupied and later calls are rejected instead of
 * creating one more detached promise per run. Run-end work has an independent
 * reserve so cancellation can still reach finalizers and observers after the
 * ordinary extension class has saturated.
 */
export class ExtensionAdmissionController {
  readonly maxActiveNormal: number;
  readonly maxActiveRunEnd: number;
  readonly maxActivePerOperation: number;
  private activeNormal = 0;
  private activeRunEnd = 0;
  private closed = false;
  private readonly activeByOperation = new Map<string, number>();
  private readonly onStateChange?: (snapshot: ExtensionAdmissionSnapshot) => void;
  private readonly logger: Logger;

  constructor(options: ExtensionAdmissionOptions = {}) {
    this.maxActiveNormal = positiveInteger(
      options.maxActiveNormal,
      DEFAULT_MAX_ACTIVE_EXTENSION_CALLS,
      "maxActiveNormal",
    );
    this.maxActiveRunEnd = positiveInteger(
      options.maxActiveRunEnd,
      DEFAULT_MAX_ACTIVE_EXTENSION_RUN_END_CALLS,
      "maxActiveRunEnd",
    );
    this.maxActivePerOperation = positiveInteger(
      options.maxActivePerOperation,
      DEFAULT_MAX_ACTIVE_EXTENSION_CALLS_PER_OPERATION,
      "maxActivePerOperation",
    );
    this.onStateChange = options.onStateChange;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  snapshot(): ExtensionAdmissionSnapshot {
    return {
      state: this.closed ? "closed" : "open",
      active: this.activeNormal + this.activeRunEnd,
      activeNormal: this.activeNormal,
      activeRunEnd: this.activeRunEnd,
      maxActiveNormal: this.maxActiveNormal,
      maxActiveRunEnd: this.maxActiveRunEnd,
      maxActivePerOperation: this.maxActivePerOperation,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.changed();
  }

  /**
   * Invoke one extension operation after claiming its physical permit.
   *
   * @throws {@link ExtensionCallUnavailableError} before invoking extension
   * code when the controller, class, or stable operation is saturated.
   */
  call<T>(
    operation: string,
    callClass: ExtensionCallClass,
    invoke: () => Promise<T> | T,
  ): Promise<T> {
    if (operation.length === 0) throw new TypeError("operation must be non-empty.");
    if (this.closed) {
      throw this.refuse(operation, callClass, "closed");
    }
    const operationKey = `${callClass}\u0000${operation}`;
    const operationActive = this.activeByOperation.get(operationKey) ?? 0;
    if (operationActive >= this.maxActivePerOperation) {
      throw this.refuse(operation, callClass, "operation_busy");
    }
    const classActive = callClass === "run_end" ? this.activeRunEnd : this.activeNormal;
    const classLimit = callClass === "run_end" ? this.maxActiveRunEnd : this.maxActiveNormal;
    if (classActive >= classLimit) {
      throw this.refuse(operation, callClass, "capacity_full");
    }

    if (callClass === "run_end") this.activeRunEnd += 1;
    else this.activeNormal += 1;
    this.activeByOperation.set(operationKey, operationActive + 1);
    this.changed();

    const physical = Promise.resolve().then(invoke);
    const release = (): void => {
      const current = this.activeByOperation.get(operationKey) ?? 1;
      if (current <= 1) this.activeByOperation.delete(operationKey);
      else this.activeByOperation.set(operationKey, current - 1);
      if (callClass === "run_end") this.activeRunEnd = Math.max(0, this.activeRunEnd - 1);
      else this.activeNormal = Math.max(0, this.activeNormal - 1);
      this.changed();
    };
    // Observe both outcomes and retain the permit until the *physical* promise
    // settles. The derived promise fulfills, so this observer cannot itself
    // become an unhandled rejection when the logical caller has timed out.
    void physical.then(release, release);
    return physical;
  }

  /**
   * Build the refusal to throw, reporting the occupancy that produced it.
   *
   * @param operation - the stable operation name that was refused.
   * @param callClass - which admission class it asked for.
   * @param reason - why it was refused.
   * @returns the error the caller throws.
   *
   * @remarks Fields only, never a template string: the payload is built at the
   * call site before any backend sees the level, and a refusal storm is
   * precisely when a host is already under pressure.
   */
  private refuse(
    operation: string,
    callClass: ExtensionCallClass,
    reason: ExtensionCallUnavailableReason,
  ): ExtensionCallUnavailableError {
    this.logger.debug(
      {
        event: "capability.extension_permit_refused",
        operation,
        call_class: callClass,
        reason,
        active_normal: this.activeNormal,
        active_run_end: this.activeRunEnd,
        max_active_per_operation: this.maxActivePerOperation,
      },
      "an extension call was refused a permit; that work is skipped rather than detached",
    );
    return new ExtensionCallUnavailableError(operation, reason);
  }

  private changed(): void {
    try {
      this.onStateChange?.(this.snapshot());
    } catch (err) {
      this.logger.debug(
        {
          event: "capability.admission_observer_failed",
          err: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
        },
        "an admission state observer threw; permits are unaffected and the snapshot is dropped",
      );
    }
  }
}

export function createExtensionAdmissionController(
  options: ExtensionAdmissionOptions = {},
): ExtensionAdmissionController {
  return new ExtensionAdmissionController(options);
}
