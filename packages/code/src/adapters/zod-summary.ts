import type { z } from "zod";

/**
 * Render the first two issues of a {@link z.ZodError} as a short, human-readable
 * summary, with a `(+N more)` suffix when there are further issues.
 *
 * @param error - the Zod validation error to summarize.
 * @returns a one-line summary suitable for a toast or error message.
 */
export function zodIssueSummary(error: z.ZodError): string {
  const issues = error.issues.slice(0, 2).map((i) => {
    const path = i.path.join(".");
    return path ? `${path}: ${i.message}` : i.message;
  });
  const more = error.issues.length - issues.length;
  return issues.join("; ") + (more > 0 ? ` (+${more} more)` : "");
}
