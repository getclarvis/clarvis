/**
 * Brief interpolation: flat field substitution, and deliberately nothing more.
 *
 * @remarks `{{args.x}}`, `{{item}}`, `{{item.field}}` and `{{state.round.field}}`
 * are the whole vocabulary. There is no conditional, no loop and no expression,
 * because a brief that needs one is a brief whose producing round should have
 * emitted the value already shaped.
 *
 * A missing key is an **error**, never an empty string. A silently truncated
 * brief produces a confident leader working on the wrong thing, which is the
 * failure the manager prompt's whole `<leader_prompt_contract>` exists to avoid.
 */

import { readPath } from "./rounds.ts";

/** The values a brief may reference. */
export interface InterpolationScope {
  args?: Record<string, unknown>;
  item?: unknown;
  state?: Record<string, unknown>;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w]*(?:\.[\w-]+)*)\s*\}\}/gu;

/** Render one resolved value into brief text. */
function render(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}

/**
 * Substitute every `{{…}}` placeholder in a brief.
 *
 * @param template - the brief as authored.
 * @param scope - the values in scope for this round and item.
 * @returns the rendered text, or an error naming the first unresolvable
 *   placeholder and what was in scope.
 */
export function interpolate(
  template: string,
  scope: InterpolationScope,
): { text: string } | { error: string } {
  let failure: string | undefined;
  const text = template.replace(PLACEHOLDER, (whole: string, path: string): string => {
    const [root, ...rest] = path.split(".");
    let value: unknown;
    if (root === "item") value = rest.length === 0 ? scope.item : readPath(scope.item, rest);
    else if (root === "args") value = readPath(scope.args ?? {}, rest);
    else if (root === "state") value = readPath(scope.state ?? {}, rest);
    else {
      failure ??= `${whole} names '${root}', which is not one of args, item or state`;
      return whole;
    }
    if (value === undefined) {
      failure ??= `${whole} did not resolve to anything`;
      return whole;
    }
    return render(value);
  });
  return failure === undefined ? { text } : { error: failure };
}

/** The placeholder roots a template references, for validation at load time. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}
