import type { Logger, ToolResult } from "@clarvis/capability";
import { NOOP_LOGGER, sanitizeErrorMessage } from "@clarvis/capability";
import type { MCPClientHandle } from "./client.ts";

const MAX_RESOURCE_BYTES = 2_000_000;
export const MAX_RESOURCE_CATALOG_PAGES = 50;
export const DEFAULT_MAX_RESOURCE_CATALOG_ENTRIES = 5_000;
export const DEFAULT_MAX_RESOURCE_CATALOG_BYTES = 4 * 1024 * 1024;

export class MCPResourceCatalogLimitError extends Error {
  readonly code = "mcp_resource_catalog_too_large" as const;
  constructor(
    readonly dimension: "entries" | "bytes" | "pages",
    readonly limit: number,
  ) {
    super(`MCP resource catalog exceeds the ${String(limit)} ${dimension} limit.`);
    this.name = "MCPResourceCatalogLimitError";
  }
}

export interface ResourceCatalogLimits {
  maxEntries?: number;
  maxBytes?: number;
  /**
   * Where a refused catalog and a failed template probe are reported.
   *
   * @remarks Carried on the limits object rather than as a parameter because
   *   both facts are produced inside {@link paginate}, which the caller reaches
   *   only through these limits. It should already carry the connection's
   *   bindings — `mcp` above all — so the record names the server it refused.
   */
  logger?: Logger;
}

export interface ResourceCatalog {
  resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
  resourceTemplates: Array<{
    uriTemplate: string;
    name: string;
    description?: string;
    mimeType?: string;
  }>;
}

export interface ResourceDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  kind?: "resource_list" | "resource_read";
}

function boundedCatalogLimit(value: number | undefined, hardMaximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return hardMaximum;
  return Math.min(hardMaximum, Math.max(0, Math.floor(value)));
}

const RESOURCE_DESCRIPTORS: readonly ResourceDescriptor[] = [
  {
    name: "list_resources",
    description:
      "List the resources this MCP server exposes (application-controlled data the agent may pull on demand). Returns each resource's uri, name, mimeType and description, plus any uri templates.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    kind: "resource_list",
  },
  {
    name: "read_resource",
    description:
      "Read one resource from this MCP server by uri (discover uris via list_resources; fill a uri template by substituting concrete values). Text is returned inline; images as image blocks; other binary is summarized, not inlined.",
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string", description: "The resource uri to read (from list_resources)." },
      },
      required: ["uri"],
      additionalProperties: false,
    },
    kind: "resource_read",
  },
];

export async function loadResourceCatalog(
  handle: MCPClientHandle,
  timeout: number,
  signal?: AbortSignal,
  limits: ResourceCatalogLimits = {},
): Promise<ResourceCatalog | null> {
  if (!handle.client.getServerCapabilities()?.resources) return null;
  const opts = (): { signal?: AbortSignal; timeout: number } => ({
    timeout,
    ...(signal ? { signal } : {}),
  });
  const logger = limits.logger ?? NOOP_LOGGER;
  const pageLimits = {
    maxItems: boundedCatalogLimit(limits.maxEntries, DEFAULT_MAX_RESOURCE_CATALOG_ENTRIES),
    maxBytes: boundedCatalogLimit(limits.maxBytes, DEFAULT_MAX_RESOURCE_CATALOG_BYTES),
    logger,
  };
  const resources = await paginate(
    (cursor) =>
      handle.client
        .listResources(cursor ? { cursor } : undefined, opts())
        .then((r) => ({ items: r.resources ?? [], nextCursor: r.nextCursor })),
    pageLimits,
  );
  let templates: Awaited<
    ReturnType<typeof handle.client.listResourceTemplates>
  >["resourceTemplates"];
  try {
    const resourceBytes = resources.reduce(
      (total, resource) => total + Buffer.byteLength(JSON.stringify(resource), "utf8"),
      0,
    );
    templates = await paginate(
      (cursor) =>
        handle.client
          .listResourceTemplates(cursor ? { cursor } : undefined, opts())
          .then((r) => ({ items: r.resourceTemplates ?? [], nextCursor: r.nextCursor })),
      {
        maxItems: Math.max(0, pageLimits.maxItems - resources.length),
        maxBytes: Math.max(0, pageLimits.maxBytes - resourceBytes),
        logger,
      },
    );
  } catch (error) {
    if (error instanceof MCPResourceCatalogLimitError) throw error;
    logger.debug(
      {
        event: "mcp.resources.templates_failed",
        reason: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
      },
      "mcp server listed no resource templates; its concrete resources are still offered",
    );
    templates = [];
  }
  return {
    resources: resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      ...(r.description !== undefined ? { description: r.description } : {}),
      ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
    })),
    resourceTemplates: templates.map((r) => ({
      uriTemplate: r.uriTemplate,
      name: r.name,
      ...(r.description !== undefined ? { description: r.description } : {}),
      ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
    })),
  };
}

export function appendResourceDescriptors<T extends ResourceDescriptor>(tools: T[]): void {
  const names = new Set(tools.map((tool) => tool.name));
  for (const descriptor of RESOURCE_DESCRIPTORS) {
    if (!names.has(descriptor.name)) tools.push(descriptor as T);
  }
}

export function catalogResult(catalog: ResourceCatalog | null): ToolResult {
  return {
    ok: true,
    data: {
      content: [
        {
          type: "text",
          text: JSON.stringify(catalog ?? { resources: [], resourceTemplates: [] }, null, 2),
        },
      ],
    },
  };
}

export function resourceReadResult(raw: unknown, uri: string): ToolResult {
  return {
    ok: true,
    data: { content: resourceContentsToBlocks((raw as { contents?: unknown }).contents, uri) },
  };
}

function resourceCatalogLimitReached(
  logger: Logger,
  kind: "entries" | "bytes" | "pages",
  limit: number,
  observed: number,
): MCPResourceCatalogLimitError {
  logger.warn(
    { event: "mcp.catalog.limit", kind, limit, observed },
    "mcp resource catalog exceeded a discovery bound; the connection is refused and none of " +
      "this server's resources are offered",
  );
  return new MCPResourceCatalogLimitError(kind, limit);
}

export async function paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
  limits?: { maxItems: number; maxBytes: number; logger?: Logger },
): Promise<T[]> {
  const logger = limits?.logger ?? NOOP_LOGGER;
  const boundedLimits =
    limits === undefined
      ? undefined
      : {
          maxItems: boundedCatalogLimit(limits.maxItems, DEFAULT_MAX_RESOURCE_CATALOG_ENTRIES),
          maxBytes: boundedCatalogLimit(limits.maxBytes, DEFAULT_MAX_RESOURCE_CATALOG_BYTES),
        };
  const out: T[] = [];
  let bytes = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_RESOURCE_CATALOG_PAGES; page += 1) {
    const { items, nextCursor } = await fetchPage(cursor);
    for (const item of items) {
      if (boundedLimits !== undefined && out.length >= boundedLimits.maxItems) {
        throw resourceCatalogLimitReached(
          logger,
          "entries",
          boundedLimits.maxItems,
          out.length + 1,
        );
      }
      if (boundedLimits !== undefined) {
        bytes += Buffer.byteLength(JSON.stringify(item), "utf8");
        if (bytes > boundedLimits.maxBytes) {
          throw resourceCatalogLimitReached(logger, "bytes", boundedLimits.maxBytes, bytes);
        }
      }
      out.push(item);
    }
    if (typeof nextCursor !== "string" || nextCursor.length === 0 || nextCursor === cursor) {
      return out;
    }
    cursor = nextCursor;
  }
  throw resourceCatalogLimitReached(
    logger,
    "pages",
    MAX_RESOURCE_CATALOG_PAGES,
    MAX_RESOURCE_CATALOG_PAGES + 1,
  );
}

export function resourceContentsToBlocks(
  contents: unknown,
  uri: string,
): Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }> {
  if (!Array.isArray(contents) || contents.length === 0)
    return [{ type: "text", text: `Resource '${uri}' returned no content.` }];
  const blocks: Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }> =
    [];
  for (const content of contents) {
    if (!content || typeof content !== "object") continue;
    const entry = content as { uri?: string; mimeType?: string; text?: unknown; blob?: unknown };
    const contentUri = typeof entry.uri === "string" ? entry.uri : uri;
    const mime = typeof entry.mimeType === "string" ? entry.mimeType : undefined;
    if (typeof entry.text === "string") blocks.push({ type: "text", text: capText(entry.text) });
    else if (typeof entry.blob === "string") {
      const bytes = base64ByteLength(entry.blob);
      if (mime?.startsWith("image/") && bytes <= MAX_RESOURCE_BYTES)
        blocks.push({ type: "image", data: entry.blob, mimeType: mime });
      else if (mime?.startsWith("image/"))
        blocks.push({
          type: "text",
          text: `image resource ${mime}, ${bytes} bytes exceeds the ${MAX_RESOURCE_BYTES}-byte inline cap — not inlined; uri=${contentUri}`,
        });
      else
        blocks.push({
          type: "text",
          text: `binary resource ${mime ?? "application/octet-stream"}, ${bytes} bytes — not inlined; uri=${contentUri}`,
        });
    }
  }
  return blocks.length > 0
    ? blocks
    : [{ type: "text", text: `Resource '${uri}' returned no readable content.` }];
}

function capText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_RESOURCE_BYTES) return text;
  const buffer = Buffer.from(text, "utf8");
  let end = MAX_RESOURCE_BYTES;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return `${buffer.subarray(0, end).toString("utf8")}\n\n[resource truncated at ${MAX_RESOURCE_BYTES} bytes]`;
}

function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}
