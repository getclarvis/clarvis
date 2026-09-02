/**
 * `@clarvis/protocol` — the transport-agnostic contract between a Clarvis kernel
 * (loop as a server) and its UI clients.
 *
 * A UI depends only on this package: wire DTOs and the {@link KernelClient}
 * interface. It never imports `@clarvis/loop`. Concrete transports (stdio /
 * Streamable HTTP / WebSocket) and the client implementation live in other packages.
 *
 * @packageDocumentation
 */

export type * from "./common.ts";
export type * from "./runs.ts";
export type * from "./config.ts";
export type * from "./plugins.ts";
export type * from "./extension-profiles.ts";
export type * from "./secrets.ts";
export type * from "./models.ts";
export type * from "./provider-auth.ts";
export type * from "./workspace.ts";
export type * from "./memory.ts";
export type * from "./plans.ts";
export type * from "./workflows.ts";
export type * from "./skills.ts";
export type * from "./sessions.ts";
export type * from "./tasks.ts";
export type * from "./storage.ts";
export type * from "./transport.ts";
export type * from "./client.ts";
