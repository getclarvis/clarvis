import { pino, type Logger as PinoLogger } from "pino";
import { DEFAULT_LOG_LEVEL, type Logger } from "@clarvis/capability";

/**
 * Options for {@link createLogger}.
 */
export interface CreateLoggerOptions {
  /**
   * The output file descriptor: `1` for stdout, `2` (the default) for stderr.
   *
   * @remarks `1` is almost always wrong and is occasionally fatal. Clarvis's own
   *   kernel wire (`serveFileKernelOverStdio`) and an MCP stdio child both use
   *   stdout for framed JSON, so a logger bound to it corrupts the protocol
   *   rather than merely being noisy. A stdio host must refuse this value.
   */
  destination?: 1 | 2;
  /**
   * The package this logger speaks for; becomes `service` on every record.
   *
   * @remarks Defaults to `@clarvis/loop` because that is where the factory
   *   lives, not because that is who is calling. It used to be hardcoded, and
   *   since this is the only factory in the repository, every `@clarvis/kernel`
   *   and `@clarvis/server` line was labelled as a loop line — so a record could
   *   not be attributed to the package that wrote it.
   */
  service?: string;
}

/**
 * Create the pino logger a host distributes to everything it composes.
 *
 * @param level - the level to emit at; defaults to `"info"`.
 * @param opts - see {@link CreateLoggerOptions}.
 * @returns a configured pino logger writing to stdout when
 *   `opts.destination === 1`, otherwise to `process.stderr`.
 * @remarks Returns pino's own logger, not the {@link Logger} port, because a
 *   host configures it (`level`) and derives from it (`child`). pino satisfies
 *   the port structurally — including its two optional members — so the value
 *   flows into any capability surface unchanged. The port is what a capability
 *   *declares*; this is the one module that knows which library backs it.
 *
 *   Per-component levels are not resolved here. A host that wants them derives
 *   `logger.child({ component }, { level })` using pino's two-argument form,
 *   with the level from `@clarvis/capability`'s `parseLogScopes`/`levelFor` over
 *   `CLARVIS_LOG` — the port's own `child` takes bindings only, deliberately.
 */
export function createLogger(
  level: string = DEFAULT_LOG_LEVEL,
  opts: CreateLoggerOptions = {},
): PinoLogger {
  const options = {
    level,
    base: { service: opts.service ?? "@clarvis/loop" },
  };
  return opts.destination === 1 ? pino(options) : pino(options, process.stderr);
}

/**
 * Re-export of the {@link Logger} port so a consumer inside the engine reaches
 * it by the same path it always did, without depending on pino.
 */
export type { Logger };
