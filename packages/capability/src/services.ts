/**
 * How one capability reaches another.
 *
 * A capability that needs a peer — the engine's `delegation` needing planning's
 * task port, a workflow manager needing the supervision registry — cannot import
 * it: the two live in different packages, and the edge that would make the import
 * legal is exactly the one the capability contract exists to remove. Instead the
 * provider publishes a port under a typed key and the consumer looks it up,
 * degrading when it is absent.
 *
 * Resolution is deliberately **lazy**: a consumer reads at `attach` time, not in
 * `forRun`. That is what removes any ordering requirement between capabilities —
 * with eager reads, a run's capability order would silently decide which
 * features could see each other, and the failure would be a missing tool rather
 * than an error.
 */
import type { CapabilityRequestView } from "./contract.ts";
import type { RunRequest } from "./api.ts";

/** Build the immutable request view shared by capability preflight and activation. */
export function createCapabilityRequestView(request: RunRequest): CapabilityRequestView {
  return {
    request,
    requestParam: (key) => (request as unknown as Record<string, unknown>)[key],
  };
}

/**
 * A typed name for a port published on {@link CapabilityServices}.
 *
 * @typeParam T - the port's interface. Carried only in the type position (`_t`
 *   is never read at runtime), so a key is just its `id` string on the wire
 *   while {@link CapabilityServices.get} still returns the right type.
 */
export interface PortKey<T> {
  readonly id: string;
  readonly _t?: T;
}

/**
 * Mint a {@link PortKey}.
 *
 * @param id - the key's identity. Namespace it by the publishing capability
 *   (`"plans.tasks"`), because two capabilities minting the same id would
 *   silently overwrite each other.
 * @returns the typed key.
 */
export function portKey<T>(id: string): PortKey<T> {
  return { id };
}

/**
 * The run-scoped registry capabilities publish ports on and read them from.
 */
export interface CapabilityServices {
  /**
   * Publish a port.
   *
   * @param key - the typed key to publish under.
   * @param value - the port implementation.
   * @throws {@link Error} when the key is already taken. A silent overwrite
   *   would make the winner depend on capability registration order, which is
   *   precisely the coupling this registry removes.
   */
  provide<T>(key: PortKey<T>, value: T): void;
  /**
   * Look a port up.
   *
   * @param key - the typed key.
   * @returns the published port, or `undefined` when nothing published it —
   *   which a consumer must treat as "that feature is off for this run", never
   *   as an error.
   */
  get<T>(key: PortKey<T>): T | undefined;
}

/**
 * Create an empty {@link CapabilityServices} for one run.
 *
 * @returns the registry; ports live as long as the run does.
 */
export function createCapabilityServices(): CapabilityServices {
  const ports = new Map<string, unknown>();
  return {
    provide<T>(key: PortKey<T>, value: T): void {
      if (ports.has(key.id)) {
        throw new Error(`capability port '${key.id}' is already provided`);
      }
      ports.set(key.id, value);
    },
    get<T>(key: PortKey<T>): T | undefined {
      return ports.get(key.id) as T | undefined;
    },
  };
}
