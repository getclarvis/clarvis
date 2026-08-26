/** Full Markdown content opened from a bounded transcript or sidebar preview. */
export interface ActivityDetail {
  title: string;
  content: string;
  eyebrow?: string;
}

/** Convert Markdown-rich activity text into one bounded navigation-surface line. */
export function activityPreview(raw: string | undefined, limit = 120): string | undefined {
  if (!raw) return undefined;
  const plain = raw
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1")
    .replace(/[`*_>#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return undefined;
  return plain.length <= limit ? plain : `${plain.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}
