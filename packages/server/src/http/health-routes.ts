/** What the readiness probe inspects. */
export interface ReadinessChecks {
  /** The kernel finished constructing. */
  kernel: () => boolean;
  /** Every settings scope parsed without error. */
  config: () => Promise<boolean>;
  /** A default model resolves to a configured provider with a key in the environment. */
  model: () => Promise<boolean>;
  /** Every required MCP server is not currently unavailable. */
  mcp: () => boolean;
  /** The process is not shutting down. */
  accepting: () => boolean;
}

/**
 * Answer the liveness probe.
 *
 * @returns always `200`.
 * @remarks Answers exactly one question — is the event loop responsive — and
 *   stays `200` through the drain. A liveness probe that checked dependencies
 *   would turn a provider outage into a restart loop.
 */
export function handleHealthz(startedAt: number): Response {
  return Response.json({ status: "ok", uptime_ms: Date.now() - startedAt });
}

/**
 * Answer the readiness probe.
 *
 * @param checks - the five conditions; see {@link ReadinessChecks}.
 * @returns `200` when all pass, else `503` naming each failing check so `curl`
 *   diagnoses a misconfiguration without log spelunking.
 * @remarks `model` is deliberately offline — it verifies the model reference, its
 *   provider entry and the presence of the key in the environment, without a
 *   provider round-trip, so readiness never flaps on someone else's outage while
 *   still catching the commonest mistake: config mounted, key forgotten.
 */
export async function handleReadyz(checks: ReadinessChecks): Promise<Response> {
  if (!checks.accepting()) {
    return Response.json({ status: "not_ready", checks: { draining: false } }, { status: 503 });
  }
  if (!checks.kernel()) {
    return Response.json({ status: "not_ready", checks: { kernel: false } }, { status: 503 });
  }
  const [config, model] = await Promise.all([checks.config(), checks.model()]);
  const mcp = checks.mcp();
  const failing: Record<string, boolean> = {};
  if (!config) failing.config = false;
  if (!model) failing.model = false;
  if (!mcp) failing.mcp = false;
  if (Object.keys(failing).length > 0) {
    return Response.json({ status: "not_ready", checks: failing }, { status: 503 });
  }
  return Response.json({ status: "ready" });
}
