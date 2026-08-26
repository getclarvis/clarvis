/**
 * Raw token tallies for one model interaction or a running total.
 *
 * @remarks `cached` counts input tokens served from the provider's prompt cache
 * (a read hit); `cache_write` counts input tokens written into that cache. The
 * two are disjoint from each other and reported separately from plain `input`.
 */
export interface TokenCounts {
  input: number;
  output: number;
  cached: number;
  cache_write: number;
}

/**
 * A {@link TokenCounts} used as a mutable running total that a loop adds into as
 * it accumulates usage across iterations.
 */
export type TokenAccumulator = TokenCounts;

/**
 * Token totals for one sub-agent profile rolled up across every instance of it.
 *
 * @remarks `iterations` is the summed iteration count across all instances and
 * `instances` is how many instances of the profile ran; the inherited
 * {@link TokenCounts} fields are the summed token tallies.
 */
export interface SubagentAggregate extends TokenCounts {
  iterations: number;
  instances: number;
}
