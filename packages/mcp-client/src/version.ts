import product from "../../../package.json" with { type: "json" };

/**
 * The Clarvis product version sent by the MCP client during initialization.
 *
 * @remarks A static import lets bundlers inline the root-owned version while
 * preserving the same relative path from both `src` and `dist`.
 */
export const VERSION: string = product.version;

/**
 * The client name sent to an MCP server in the `initialize` handshake.
 *
 * @remarks Wire-visible: a server logs or gates on it. It named `@clarvis/loop`
 *   while the MCP layer lived inside the engine; it names the package that
 *   actually speaks the protocol now.
 */
export const CLIENT_NAME = "@clarvis/mcp-client";
