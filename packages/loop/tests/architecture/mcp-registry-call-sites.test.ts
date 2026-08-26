import { describe, it, expect } from "../bun-test.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * The wire name a call reaches is decided by the registry it was built into, and
 * a run has three of them — the entry agent's, the lead's spawnable set, and each
 * spawned sub-agent's. `buildRegistry` reserves the *engine's* vocabulary itself,
 * but the names a capability owns arrive as an argument, so a call site that omits
 * it silently lets an MCP server take one.
 *
 * That is not hypothetical: when the argument was optional, exactly one call site
 * passed it, and every unit test still passed, because each exercises
 * `buildRegistry` in isolation where `[]` is the right answer. Only reading the
 * call sites can see it. The argument is required now, so this guards the shape
 * of the fix rather than the fix itself — a future default would restore the
 * silence a compile error currently prevents.
 *
 * There was a fourth: the vision delegate's. The vision pre-pass is a single
 * model call with no tools now, so it builds no registry at all.
 */
describe("every buildRegistry call site names the run's reserved set", () => {
  const callSites: { file: string; snippet: string }[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    if (file.endsWith(join("tools", "mcp-registry.ts"))) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf("buildRegistry(", from);
      if (at === -1) break;
      let depth = 0;
      let i = at + "buildRegistry".length;
      for (; i < text.length; i += 1) {
        const c = text[i]!;
        if (c === "(" || c === "[" || c === "{") depth += 1;
        else if (c === ")" || c === "]" || c === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      callSites.push({ file, snippet: text.slice(at, i + 1) });
      from = i + 1;
    }
  }

  it("finds every registry a run builds, so the check cannot pass by finding none", () => {
    expect(callSites.length).toBeGreaterThanOrEqual(3);
  });

  it("passes a second argument at each one", () => {
    for (const site of callSites) {
      const inner = site.snippet.slice("buildRegistry(".length, -1);
      const args: string[] = [];
      let depth = 0;
      let current = "";
      for (const ch of inner) {
        if (ch === "(" || ch === "[" || ch === "{") depth += 1;
        else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
        if (ch === "," && depth === 0) {
          args.push(current);
          current = "";
          continue;
        }
        current += ch;
      }
      args.push(current);
      const named = args.map((a) => a.trim()).filter((a) => a.length > 0);
      expect(`${site.file}: ${named.length} arg(s)`).toBe(`${site.file}: 2 arg(s)`);
    }
  });
});
