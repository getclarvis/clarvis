/** Limits applied before recursive sanitizers or serializers touch an open value. */
export interface BoundJsonValueOptions {
  maxDepth: number;
  maxNodes: number;
  /** Shared UTF-16 input budget across string values and object keys. */
  maxChars: number;
  transformKey?: (key: string) => string;
}

export interface BoundedJsonValue {
  value: unknown;
  truncated: boolean;
}

/**
 * Copy an arbitrary value into a finite, getter-free JSON-compatible tree.
 *
 * @remarks This is deliberately the step *before* secret/terminal sanitization:
 * those recursive transforms must never receive a cyclic, excessively deep, or
 * enormous graph. Accessors and exotic objects are represented by inert labels;
 * no `toJSON` or user getter is invoked.
 */
export function boundJsonValue(value: unknown, options: BoundJsonValueOptions): BoundedJsonValue {
  let nodes = 0;
  let remainingChars = options.maxChars;
  let truncated = false;
  const ancestors = new WeakSet<object>();

  const text = (input: string): string => {
    if (remainingChars <= 0) {
      truncated = true;
      return "";
    }
    const take = Math.min(input.length, remainingChars);
    const output = input.slice(0, take);
    remainingChars -= take;
    if (take < input.length) truncated = true;
    return output;
  };

  const visit = (input: unknown, depth: number, inArray = false): unknown => {
    nodes += 1;
    if (nodes > options.maxNodes) {
      truncated = true;
      return "[json node limit]";
    }
    if (typeof input === "string") return text(input);
    if (
      input === null ||
      typeof input === "boolean" ||
      (typeof input === "number" && Number.isFinite(input))
    ) {
      return input;
    }
    if (typeof input === "number") return null;
    if (input === undefined) return inArray ? null : undefined;
    if (typeof input !== "object") {
      truncated = true;
      return `[unsupported ${typeof input}]`;
    }
    if (depth >= options.maxDepth) {
      truncated = true;
      return "[json depth limit]";
    }
    if (ancestors.has(input)) {
      truncated = true;
      return "[circular value]";
    }
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        const length = Math.min(input.length, options.maxNodes - nodes);
        if (length < input.length) truncated = true;
        const output: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          let entry: unknown;
          try {
            const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
            if (descriptor === undefined) entry = null;
            else if (!("value" in descriptor)) {
              truncated = true;
              entry = "[accessor omitted]";
            } else entry = descriptor.value;
          } catch {
            truncated = true;
            entry = "[unreadable value]";
          }
          output.push(visit(entry, depth + 1, true));
        }
        return output;
      }
      const prototype: unknown = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        truncated = true;
        return "[unsupported object]";
      }
      const output: Record<string, unknown> = {};
      for (const rawKey in input as Record<string, unknown>) {
        if (!Object.prototype.hasOwnProperty.call(input, rawKey)) continue;
        if (nodes >= options.maxNodes || remainingChars <= 0) {
          truncated = true;
          break;
        }
        const boundedKey = text(rawKey);
        const key = options.transformKey?.(boundedKey) ?? boundedKey;
        try {
          const descriptor = Object.getOwnPropertyDescriptor(input, rawKey);
          if (descriptor === undefined) continue;
          if (!("value" in descriptor)) {
            truncated = true;
            output[key] = "[accessor omitted]";
          } else output[key] = visit(descriptor.value, depth + 1);
        } catch {
          truncated = true;
          output[key] = "[unreadable value]";
        }
      }
      return output;
    } catch {
      truncated = true;
      return "[unreadable value]";
    } finally {
      ancestors.delete(input);
    }
  };

  return { value: visit(value, 0), truncated };
}
