import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { TraceEvent } from "@clarvis/capability";
import { verifyTraceNormativeSources } from "../../src/goals/trace-reads.ts";

const full = "==> first.txt <==\n     1\tfirst\n\n==> last.txt <==\n     1\tlast";
function trace(result: string, attested: string = full): TraceEvent[] {
  return [
    {
      type: "tool_call",
      agent: "subagent",
      subagent_instance_id: "goal-steward",
      iteration_ref: 1,
      started_at: 1,
      ended_at: 2,
      mcp_name: "read_files",
      tool_name: "",
      arguments: { paths: ["first.txt", "last.txt"] },
      result,
      result_digest: createHash("sha256").update(attested).digest("hex"),
      error: null,
    },
  ];
}

it("attests an abbreviated batch including files absent from the display trace", async () => {
  const readFile = async (path: string) => ({
    path,
    content: path === "first.txt" ? "first\n" : "last\n",
  });
  const result = await verifyTraceNormativeSources({
    trace: trace("==> first...[truncated]"),
    paths: ["last.txt"],
    readFile,
  });
  expect(result).toEqual([
    { path: "last.txt", digest: createHash("sha256").update("last\n").digest("hex") },
  ]);
});

for (const mismatch of ["changed", "missing", "partial", "forged", "unlisted"]) {
  it(`rejects ${mismatch} batch evidence despite an abbreviated display`, async () => {
    await expect(
      verifyTraceNormativeSources({
        trace: trace(
          "==> first...[truncated]",
          mismatch === "partial"
            ? full.slice(0, 40) + "[... more file(s) not shown ...]"
            : mismatch === "forged"
              ? "unrelated"
              : full,
        ),
        paths: [mismatch === "unlisted" ? "other.txt" : "last.txt"],
        readFile: async (path) => {
          if (mismatch === "missing" && path === "first.txt") throw new Error("missing");
          return {
            path,
            content: path === "first.txt" ? (mismatch === "changed" ? "changed" : "first") : "last",
          };
        },
      }),
    ).rejects.toThrow("not read completely");
  });
}

for (const content of [
  "",
  "\uFEFFfirst\r\nlast\r\n",
  "continue with offset=",
  "use read_file for the rest",
  "more file(s) not shown",
]) {
  for (const tool of ["read_file", "read_files"]) {
    it(`accepts complete ${tool} content ${JSON.stringify(content)} without mistaking text for truncation`, async () => {
      const normalized = content.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
      const lines = normalized.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const body =
        normalized === ""
          ? "(empty file)"
          : lines.map((line, index) => `${String(index + 1).padStart(6)}\t${line}`).join("\n");
      const output = tool === "read_file" ? body : `==> first.txt <==\n${body}`;
      const events = trace(output, output);
      const event = events[0]!;
      Object.assign(event, {
        mcp_name: tool,
        arguments: tool === "read_file" ? { path: "first.txt" } : { paths: ["first.txt"] },
      });
      const result = await verifyTraceNormativeSources({
        trace: events,
        paths: ["first.txt"],
        readFile: async (path) => ({ path, content }),
      });
      expect(result).toHaveLength(1);
    });
  }
}

it("retains a complete batch section while rejecting a later tool-truncated file", async () => {
  const partial =
    "==> first.txt <==\n     1\tfirst\n\n==> last.txt <==\n     1\tpart\n[... 1 of 2 lines shown; use read_file for the rest ...]";
  const options = {
    trace: trace(partial, partial),
    readFile: async (path: string) => ({
      path,
      content: path === "first.txt" ? "first" : "part\nrest",
    }),
  };
  expect(await verifyTraceNormativeSources({ ...options, paths: ["first.txt"] })).toHaveLength(1);
  await expect(verifyTraceNormativeSources({ ...options, paths: ["last.txt"] })).rejects.toThrow(
    "not read completely",
  );
});

it("allows partial exploration in observations without attesting incomplete files", async () => {
  const events = trace("==> first.txt <==\n     1\tfirst\n\n==> last.txt <==\n     1\tpart");
  const options = {
    trace: events,
    paths: ["first.txt", "last.txt"],
    readFile: async (path: string) => ({
      path,
      content: path === "first.txt" ? "first" : "part\nrest",
    }),
  };
  expect(await verifyTraceNormativeSources({ ...options, allowIncomplete: true })).toEqual([
    { path: "first.txt", digest: createHash("sha256").update("first").digest("hex") },
  ]);
  await expect(verifyTraceNormativeSources(options)).rejects.toThrow("not read completely");
});
