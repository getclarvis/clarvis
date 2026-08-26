import product from "../../../package.json" with { type: "json" };

/**
 * The Clarvis product version, read from the root manifest at load.
 *
 * @remarks A static import lets bundlers inline the single product version while
 * preserving the same relative path from both `src` and `dist`.
 */
export const VERSION: string = product.version;
