function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (lower === "id") return "ID";
      if (lower === "url") return "URL";
      if (lower === "api") return "API";
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

function scalarText(value: unknown): string | null {
  if (value === null) return "null";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim() || '""';
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function heading(level: number, text: string): string {
  return `${"#".repeat(Math.min(6, Math.max(2, level)))} ${text}`;
}

function identityOf(value: Record<string, unknown>): { key: string; text: string } | undefined {
  for (const key of ["title", "name", "path", "id"]) {
    const text = scalarText(value[key]);
    if (text !== null && text !== "null" && text !== '""') return { key, text };
  }
  return undefined;
}

function appendObject(
  lines: string[],
  value: Record<string, unknown>,
  level: number,
  seen: WeakSet<object>,
  omittedKey?: string,
): void {
  if (seen.has(value)) throw new TypeError("cyclic workflow result");
  seen.add(value);
  const entries = Object.entries(value).filter(([key]) => key !== omittedKey);
  if (entries.length === 0) lines.push("_(empty)_");
  for (const [key, child] of entries) {
    const scalar = scalarText(child);
    if (scalar !== null) {
      lines.push(`- **${fieldLabel(key)}:** ${scalar}`);
      continue;
    }
    lines.push("", heading(level, fieldLabel(key)), "");
    appendValue(lines, child, level + 1, seen);
  }
  seen.delete(value);
}

function appendArray(
  lines: string[],
  value: unknown[],
  level: number,
  seen: WeakSet<object>,
): void {
  if (seen.has(value)) throw new TypeError("cyclic workflow result");
  seen.add(value);
  if (value.length === 0) lines.push("_(none)_");
  value.forEach((child, index) => {
    const scalar = scalarText(child);
    if (scalar !== null) {
      lines.push(`- ${scalar}`);
      return;
    }
    if (Array.isArray(child)) {
      lines.push("", heading(level, String(index + 1)), "");
      appendArray(lines, child, level + 1, seen);
      return;
    }
    if (child !== null && typeof child === "object") {
      const record = child as Record<string, unknown>;
      const identity = identityOf(record);
      const title = identity === undefined ? String(index + 1) : `${index + 1}. ${identity.text}`;
      lines.push("", heading(level, title), "");
      appendObject(lines, record, level + 1, seen, identity?.key);
      return;
    }
    lines.push(`- ${String(child)}`);
  });
  seen.delete(value);
}

function appendValue(lines: string[], value: unknown, level: number, seen: WeakSet<object>): void {
  if (Array.isArray(value)) {
    appendArray(lines, value, level, seen);
    return;
  }
  if (value !== null && typeof value === "object") {
    appendObject(lines, value as Record<string, unknown>, level, seen);
    return;
  }
  lines.push(scalarText(value) ?? String(value));
}

/**
 * Turn a JSON-shaped workflow result into word-wrapped Markdown sections.
 *
 * A workflow controls its result schema, so the viewer cannot rely on one
 * domain-specific card. This projection preserves every field while promoting
 * arrays and nested objects into scannable headings instead of one long JSON
 * line.
 */
export function formatStructuredWorkflowResult(value: object): string {
  const lines = ["**Structured result**", ""];
  appendValue(lines, value, 2, new WeakSet());
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/** Parse only JSON containers; ordinary prose and scalar-looking strings stay untouched. */
export function parseStructuredWorkflowResult(value: string): object | undefined {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
