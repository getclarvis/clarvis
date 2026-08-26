/**
 * A refusal the model reads must never hand it the way around itself.
 *
 * @remarks `assertWithinWorkspace` used to refuse with
 * `(set ALLOW_OUTSIDE_WORKSPACE=1 to permit)`. That string is a tool *result*,
 * so its reader is the agent — the party the boundary exists to bound — and an
 * agent trying to finish a task reads a remediation hint as the next step. It
 * will export the variable in a `shell` call, write it into a config file, or
 * ask the user to. Teaching that once generalises: a model that learns to look
 * for the off switch here tries it against the next confinement too.
 *
 * The rule is not "no helpful errors" — it is that the audience decides. An
 * operator reading `clarvis-server --help` or a boot failure on their own
 * terminal *should* be told about `--allow-public-bind`; those never reach a
 * model. This scans only the strings that become tool results.
 *
 * It scans for the shape rather than for one known string, because the next
 * occurrence will be a different variable in a different tool.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(PKG, "src");

/**
 * Remediation phrasing that would tell a reader how to lift a restriction.
 *
 * @remarks Deliberately narrow. It matches an instruction to *set* something
 * (an env var, a flag) followed by permissive language, which is what a bypass
 * hint looks like; it does not match a plain mention of a variable name, since
 * naming one in prose is often necessary and harmless.
 */
const BYPASS_HINT =
  /\b(set|pass|export|use)\s+(?:--[a-z][a-z0-9-]{4,}|[A-Z][A-Z0-9_]{3,})[^\n]{0,40}?\bto\s+(permit|allow|disable|bypass|override|skip|turn)/;

/** A shorter, blunter form: `FOO=1 to permit`. */
const ASSIGNMENT_HINT = /[A-Z_]{4,}=\S*\s+to\s+(permit|allow|disable|bypass|override)/;

/** Every `.ts` file under `dir`, recursively. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...sources(abs));
    else if (abs.endsWith(".ts")) out.push(abs);
  }
  return out;
}

/** Whether a line is comment text rather than a runtime string. */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

/** `<path>:<line>` for every line that reads like a bypass hint. */
function hints(): string[] {
  const found: string[] = [];
  for (const file of sources(SRC)) {
    const rel = relative(PKG, file).split("\\").join("/");
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (isComment(line)) return;
        if (BYPASS_HINT.test(line) || ASSIGNMENT_HINT.test(line)) {
          found.push(`${rel}:${String(i + 1)}`);
        }
      });
  }
  return found;
}

describe("model-facing refusals do not explain how to lift the restriction", () => {
  it("scans a non-trivial number of files, so a green run means something", () => {
    expect(sources(SRC).length).toBeGreaterThan(30);
  });

  it("finds no bypass hint in any tool message", () => {
    expect(hints()).toEqual([]);
  });

  it("recognises the shape it is guarding against", () => {
    for (const line of [
      "  `Path escapes the workspace root: ${input} (set ALLOW_OUTSIDE_WORKSPACE=1 to permit)`,",
      '  "Sandbox unavailable (set CLARVIS_SANDBOX_OPTIONAL=1 to allow)",',
      '  "Refused: pass --allow-anything to override",',
    ]) {
      expect(BYPASS_HINT.test(line) || ASSIGNMENT_HINT.test(line)).toBe(true);
    }
  });

  it("does not fire on a refusal that merely states the boundary", () => {
    for (const line of [
      "  `Path escapes the workspace root: ${input}. Only paths inside the workspace are `,",
      '  "This boundary is set before the run starts and cannot be changed from within it.",',
      "  const raw = env.ALLOW_OUTSIDE_WORKSPACE;",
    ]) {
      expect(BYPASS_HINT.test(line) || ASSIGNMENT_HINT.test(line)).toBe(false);
    }
  });
});
