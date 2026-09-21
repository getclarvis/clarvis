/**
 * Nothing in this repository decides, for the model, which tool it must call.
 *
 * @remarks
 * The engine used to answer a finalize gate's nudge by putting
 * `toolChoice: "required"` on the next call, and to pin `set_title` on the
 * workflow-title call. Both were removed: "you must call something" answers a
 * wrong-*tool* problem with a different wrong tool, and a provider that refuses a
 * forced choice outright — a thinking model, for one — turned the recovery into an
 * HTTP 400 that ended the run. What remains legitimate is plumbing that carries a
 * choice the caller supplied, or translates one a contract explicitly declared.
 *
 * This scan is the cheap half of that contract; the behavioural half is asserting
 * on the requests a provider actually received (`no forced choice` cases in
 * `packages/loop/tests/component/lifecycle-finalize-wiring.test.ts`,
 * `packages/kernel/tests/unit/workflow-title.test.ts` and the goal fixture's own
 * thinking-model refusal in `packages/kernel/tests/helpers/goal-file-host.ts`).
 * Both halves are needed: a text scan cannot see a choice assembled at runtime,
 * and a request assertion only covers the paths its suite drives.
 *
 * Scope is each package's `src/` tree: tests, fixtures and tooling may legitimately
 * build a forced call to prove the transport translates one, which is a different
 * claim from the product making that call.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..", "..", "..");

/** Every place in production source that may name a tool choice, and why. */
const CARRIERS: Readonly<Record<string, string>> = {
  "packages/capability/src/llm-port.ts": "declares the caller-supplied field on LLMCallParams",
  "packages/llm/src/ai-sdk/request-options.ts": "translates a supplied choice for the AI SDK",
  "packages/kernel/src/hosting/container-model-contract.ts":
    "carries the field across the Container model contract",
  "packages/kernel/src/runtime/model-broker-host.ts": "forwards the field to the provider",
};

/** A decision to force a call, rather than a value passed through. */
const FORCED = [
  /toolChoice\s*:\s*"required"/,
  /toolChoice\s*:\s*\{/,
  /toolChoice\s*=\s*("required"|\{)/,
];

/** TSDoc writes the field name in backticks, which no regex can tell from code. */
function isComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
}

async function scanning(): Promise<{ carriers: string[]; forced: string[] }> {
  const carriers: string[] = [];
  const forced: string[] = [];
  for await (const match of new Glob("packages/*/src/**/*.{ts,tsx}").scan({ cwd: repoRoot })) {
    const relative = match.split(sep).join("/");
    const text = await readFile(join(repoRoot, match), "utf8");
    const lines = text.split("\n").filter((line) => !isComment(line));
    if (lines.some((line) => line.includes("toolChoice"))) carriers.push(relative);
    for (const pattern of FORCED)
      if (lines.some((line) => pattern.test(line))) {
        forced.push(relative);
        break;
      }
  }
  return { carriers: carriers.sort(), forced: forced.sort() };
}

describe("no production source imposes a tool choice", () => {
  test("the only files naming a tool choice are the plumbing that carries one", async () => {
    const { carriers } = await scanning();
    expect(carriers).toEqual(Object.keys(CARRIERS).sort());
  });

  test("no file writes a forced choice at all", async () => {
    const { forced } = await scanning();
    expect(forced).toEqual([]);
  });

  test("every recorded carrier states what it carries", () => {
    for (const [file, reason] of Object.entries(CARRIERS)) expect(reason, file).not.toBe("");
  });
});
