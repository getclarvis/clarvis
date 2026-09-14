import { createHash } from "node:crypto";

/** Maximum UTF-8 bytes of a Container configuration, including all embedded instruction data. */
export const CONTAINER_CONFIGURATION_MAX_BYTES = 4 * 1024 * 1024;

/** Canonical JSON with sorted object keys, ordered arrays, bounded depth and no lossy JSON values. */
export function canonicalContainerJson(
  value: unknown,
  maximumBytes = CONTAINER_CONFIGURATION_MAX_BYTES,
): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > 8 * 1024 * 1024) {
    throw new RangeError("Invalid Container JSON byte limit");
  }
  const ancestors = new Set<object>();
  let bytes = 0;
  const charge = (text: string): string => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > maximumBytes) throw new RangeError("Container JSON exceeds its byte limit");
    return text;
  };
  const visit = (item: unknown, depth: number): string => {
    if (depth > 64) throw new Error("Container JSON nesting exceeds 64");
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return charge(JSON.stringify(item));
    if (typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0))
      return charge(JSON.stringify(item));
    if (typeof item !== "object" || item === null)
      throw new Error("Container configuration requires lossless JSON");
    if (ancestors.has(item)) throw new Error("Container configuration contains a cycle");
    const array = Array.isArray(item);
    if (
      !array &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new Error("Container configuration requires plain JSON objects");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(item).some((key) => typeof key !== "string"))
      throw new Error("Container JSON forbids symbol keys");
    const entries = Object.entries(descriptors).filter(([key]) => !(array && key === "length"));
    for (const [, descriptor] of entries) {
      if (!descriptor.enumerable || !("value" in descriptor))
        throw new Error("Container JSON forbids accessors and hidden fields");
    }
    if (
      array &&
      (entries.length !== item.length || entries.some(([name], index) => name !== String(index)))
    )
      throw new Error("Container JSON forbids sparse or decorated arrays");
    ancestors.add(item);
    charge(array ? "[]" : "{}");
    if (!array) entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const parts = entries.map(([name, descriptor]) => {
      const prefix = array ? "" : charge(JSON.stringify(name) + ":");
      return prefix + visit(descriptor.value, depth + 1);
    });
    if (parts.length > 1) charge(",".repeat(parts.length - 1));
    ancestors.delete(item);
    return (array ? "[" : "{") + parts.join(",") + (array ? "]" : "}");
  };
  return visit(value, 0);
}

/** SHA-256 over canonical UTF-8 JSON, never over host source paths or source formatting. */
export function digestContainerJson(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalContainerJson(value), "utf8").digest("hex")}`;
}

/** Freeze every JSON child after validation; callers never retain host-owned mutable references. */
export function freezeContainerData<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freezeContainerData(child);
    Object.freeze(value);
  }
  return value;
}
