import { expect, test } from "bun:test";
import {
  editsFromArgs,
  parseBash,
  parseGrepContent,
  parseJsonObject,
  parseMonitor,
  parsePathList,
  parseReadFile,
  parseReadFiles,
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

test("editsFromArgs reads both single and array forms", () => {
  expect(editsFromArgs({ old_string: "a", new_string: "b" })).toEqual([
    { oldText: "a", newText: "b" },
  ]);
  expect(
    editsFromArgs({
      edits: [
        { old_string: "x", new_string: "y" },
        { old_string: "p", new_string: "q" },
      ],
    }),
  ).toEqual([
    { oldText: "x", newText: "y" },
    { oldText: "p", newText: "q" },
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

test("parseReadFiles splits on headers, keeps bodies, and surfaces per-file errors", () => {
  const result = [
    "==> src/a.ts <==",
    "     1\tconst a = 1",
    "     2\tconst b = 2",
    "==> src/missing.ts — not_found: no such file <==",
    "==> src/c.ts <==",
    "     1\tok()",
    "[... 2 more file(s) not shown ...]",
  ].join("\n");
  const { sections, note } = parseReadFiles(result);
  expect(sections.length).toBe(3);
  expect(sections[0]!.path).toBe("src/a.ts");
  expect(sections[0]!.error).toBeNull();
  expect(sections[0]!.body).toBe("     1\tconst a = 1\n     2\tconst b = 2");
  expect(sections[1]!.path).toBe("src/missing.ts");
  expect(sections[1]!.error).toBe("not_found: no such file");
  expect(sections[1]!.body).toBe("");
  expect(sections[2]!.path).toBe("src/c.ts");
  expect(note).toBe("[... 2 more file(s) not shown ...]");
});

test("parseMonitor keeps ready/exit_code tri-state (null is not false)", () => {
  const started = parseMonitor(
    JSON.stringify({ id: "m1", running: true, ready: null, output: "boot\n", next_offset: 5 }),
    null,
  );
  expect(started!.isList).toBe(false);
  expect(started!.id).toBe("m1");
  expect(started!.running).toBe(true);
  expect(started!.ready).toBeNull();
  expect(started!.hasExitCode).toBe(false);

  const polled = parseMonitor(
    JSON.stringify({ running: false, output: "", next_offset: 9, exit_code: 0 }),
    null,
  );
  expect(polled!.running).toBe(false);
  expect(polled!.hasExitCode).toBe(true);
  expect(polled!.exitCode).toBe(0);

  const notReady = parseMonitor(
    JSON.stringify({ id: "m2", running: true, ready: false, output: "", next_offset: 0 }),
    null,
  );
  expect(notReady!.ready).toBe(false);
});

test("parseMonitor recognises the list shape", () => {
  const m = parseMonitor(
    JSON.stringify({
      monitors: [{ id: "a", command: "npm run dev", running: true, started_at: 1, cwd: "." }],
    }),
    null,
  );
  expect(m!.isList).toBe(true);
  expect(m!.monitors).toEqual([{ id: "a", command: "npm run dev", running: true }]);
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

test("parseMonitor: an unknown-id error falls through instead of rendering an empty status", () => {
  const err = JSON.stringify({ error: "monitor_not_found", message: "no monitor mon_1" });
  expect(parseMonitor(err, err)).toBeUndefined();
});

test("parseMonitor: a real status payload still parses", () => {
  const ok = JSON.stringify({ id: "mon_1", command: "sleep 1", running: true, output: "x" });
  expect(parseMonitor(ok, null)?.id).toBe("mon_1");
});
