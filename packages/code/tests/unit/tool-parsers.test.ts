import { expect, test } from "bun:test";
import {
  editsFromArgs,
  parseBash,
  toolErrorSummaryText,
  parseGrepContent,
  parseJsonObject,
  parseShellSession,
  parsePathList,
  parseReadFile,
  synthesizeUnifiedDiff,
} from "../../src/adapters/tool-parsers.ts";

test("parseBash reads the JSON envelope (non-zero exit is not an error)", () => {
  const r = parseBash(
    JSON.stringify({
      exit_code: 2,
      stdout: "out\n",
      stderr: "boom\n",
      signal: null,
      timed_out: false,
    }),
    null,
  );
  expect(r).toEqual({
    exitCode: 2,
    stdout: "out\n",
    stderr: "boom\n",
    signal: null,
    timedOut: false,
    parsed: true,
  });
});

test("parseBash falls back for a non-JSON result", () => {
  const r = parseBash("plain output", null);
  expect(r.parsed).toBe(false);
  expect(r.stdout).toBe("plain output");
  expect(r.exitCode).toBeNull();
});

test("toolErrorSummaryText humanizes structured codes and preserves plain errors", () => {
  expect(
    toolErrorSummaryText(
      JSON.stringify({
        error: "patch_failed",
        message: "Hunk did not apply cleanly in packages/code/tests/unit/keyspec.test.ts",
        file: "packages/code/tests/unit/keyspec.test.ts",
      }),
    ),
  ).toBe("Patch failed: Hunk did not apply cleanly in packages/code/tests/unit/keyspec.test.ts");
  expect(toolErrorSummaryText("denied: command was rejected by the selected policy")).toBe(
    "Denied: command was rejected by the selected policy",
  );
  expect(toolErrorSummaryText("ENOENT: no such file")).toBe("ENOENT: no such file");
});

test("parseBash reads a JSON error object (timeout)", () => {
  const r = parseBash(
    "",
    JSON.stringify({ exit_code: null, stdout: "partial", stderr: "", timed_out: true }),
  );
  expect(r.timedOut).toBe(true);
  expect(r.stdout).toBe("partial");
});

// The engine reports a tool failure as `result` AND `error` carrying the same
// sentence, which is right for every tool whose result is an envelope. `shell`'s
// is not one when the call never reached a shell — a truncated tool payload, a
// rejected argument schema, a guard denial — and echoing both printed the whole
// message twice, once as body text and once in red.
test("parseBash does not echo an unparsable result that is just the error again", () => {
  const message = 'The arguments for \'shell\' arrived truncated. What arrived was: {"command":"np';
  const r = parseBash(message, message);
  expect(r.parsed).toBe(false);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe(message);
});

test("parseBash still keeps genuine partial output alongside a different error", () => {
  const r = parseBash("partial output", "it broke");
  expect(r.stdout).toBe("partial output");
  expect(r.stderr).toBe("it broke");
});

test("parseReadFile strips the number\\t gutter and keeps the range + notes", () => {
  const result = [
    "    10\tconst a = 1",
    "    11\tconst b = 2",
    "[... 2 of 40 lines shown; continue with offset=12 ...]",
  ].join("\n");
  const r = parseReadFile(result);
  expect(r.firstLine).toBe(10);
  expect(r.content).toBe("const a = 1\nconst b = 2");
  expect(r.notes).toEqual(["[... 2 of 40 lines shown; continue with offset=12 ...]"]);
});

test("parseGrepContent groups match/context rows by path and honours --", () => {
  const result = [
    "src/a.ts:10:const x = 1",
    "src/a.ts-11-  // context",
    "--",
    "src/b.ts:3:foo()",
    "(this is a continuation)",
  ].join("\n");
  const { groups, noMatches } = parseGrepContent(result);
  expect(noMatches).toBe(false);
  expect(groups.length).toBe(2);
  expect(groups[0]!.path).toBe("src/a.ts");
  expect(groups[0]!.rows[0]).toEqual({ line: 10, text: "const x = 1", match: true });
  expect(groups[0]!.rows[1]).toEqual({ line: 11, text: "  // context", match: false });
  expect(groups[1]!.path).toBe("src/b.ts");
  expect(groups[1]!.rows[0]!.text).toBe("foo()\n(this is a continuation)");
});

test("parseGrepContent handles (no matches)", () => {
  expect(parseGrepContent("(no matches)")).toEqual({ groups: [], noMatches: true });
});

test("parsePathList splits paths and empties on (no matches)", () => {
  expect(parsePathList("a.ts\nb.ts\n")).toEqual(["a.ts", "b.ts"]);
  expect(parsePathList("(no matches)")).toEqual([]);
});

test("editsFromArgs reads edit arguments", () => {
  expect(editsFromArgs({ old_string: "a", new_string: "b" })).toEqual([
    { oldText: "a", newText: "b" },
  ]);
  expect(editsFromArgs({})).toEqual([]);
});

test("synthesizeUnifiedDiff produces a parseable minimal diff", () => {
  const d = synthesizeUnifiedDiff("src/x.ts", [{ oldText: "const a = 1", newText: "const a = 2" }]);
  expect(d).toContain("--- a/src/x.ts");
  expect(d).toContain("+++ b/src/x.ts");
  expect(d).toContain("@@ -1,1 +1,1 @@");
  expect(d).toContain("-const a = 1");
  expect(d).toContain("+const a = 2");
});

test("parseJsonObject returns undefined for non-objects", () => {
  expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
  expect(parseJsonObject("not json")).toBeUndefined();
  expect(parseJsonObject("[1,2]")).toBeUndefined();
});
test("parseShellSession keeps bounded status and stream fields", () => {
  const started = parseShellSession(
    JSON.stringify({
      session_id: "ses_1",
      running: true,
      ready: false,
      stdout: "boot\n",
      stderr: "warn\n",
    }),
    null,
  );
  expect(started).toMatchObject({
    id: "ses_1",
    running: true,
    ready: false,
    stdout: "boot\n",
    stderr: "warn\n",
  });
  const listed = parseShellSession(
    JSON.stringify({ sessions: [{ session_id: "ses_1", running: true, exit_code: null }] }),
    null,
  );
  expect(listed?.sessions).toEqual([{ id: "ses_1", running: true, exitCode: null }]);
});

test("parseBash: a guard denial is not a shell envelope and must not read as success", () => {
  const denial = JSON.stringify({ error: "denied", message: "command not in the allowed list" });
  const r = parseBash(denial, denial);
  // Before: `parsed: true` with empty stdout/stderr, which the renderer painted
  // as `done` with no body — the error text shown zero times.
  expect(r.parsed).toBe(false);
  expect(r.stderr).toContain("command not in the allowed list");
  expect(r.stdout).toBe("");
});

test("parseBash: an error payload with only a code still says the code", () => {
  const denial = JSON.stringify({ error: "workspace_confinement" });
  const r = parseBash(denial, denial);
  expect(r.parsed).toBe(false);
  expect(r.stderr).toBe("workspace_confinement");
});

test("parseBash: a genuine success envelope is still parsed, including an all-empty one", () => {
  const r = parseBash(JSON.stringify({ exit_code: 0, stdout: "", stderr: "" }), null);
  expect(r.parsed).toBe(true);
  expect(r.exitCode).toBe(0);
});

test("parseShellSession leaves typed errors to the generic renderer", () => {
  const err = JSON.stringify({ error: "not_found", message: "no session", session_id: "ses_1" });
  expect(parseShellSession(err, err)).toBeUndefined();
});
