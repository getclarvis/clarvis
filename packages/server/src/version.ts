import product from "../../../package.json" with { type: "json" };

/** The root-owned Clarvis product version reported by the server CLI. */
export const PRODUCT_VERSION: string = product.version;
