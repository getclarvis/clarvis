/**
 * Supported engine-adapter surface for workflow implementations.
 *
 * @remarks This entry exposes only the elicitation serializer a workflow
 * capability needs to integrate with the loop runtime. Shared contracts come
 * directly from `@clarvis/capability` and are not re-exported here.
 *
 * Supervision is deliberately **not** among them. `registerBackgroundChild` and
 * the registry it writes to used to be re-exported here, which is how
 * `@clarvis/workflows` came to reach an internal of the engine it sits above.
 * They now live in `@clarvis/supervision`, a leaf both packages depend on
 * directly, and this entry carries only what is genuinely an engine adapter.
 */
export { createElicitSerializer } from "./runtime/elicit-relay.ts";
