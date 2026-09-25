import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { TraceEvent } from "@clarvis/capability";
import { verifyTraceNormativeSources } from "../../src/goals/trace-reads.ts";

function trace(result: string, path = "first.txt", digest = true): TraceEvent[] {
  return [
    {
      type: "tool_call",
      agent: "subagent",
      subagent_instance_id: "goal-steward",
      iteration_ref: 1,
      started_at: 1,
      ended_at: 2,
      mcp_name: "read_file",
      tool_name: "",
      arguments: { path },
      result,
      ...(digest ? { result_digest: createHash("sha256").update(result).digest("hex") } : {}),
      error: null,
    },
  ];
}

for (const content of [
  "",
  "\uFEFFfirst\r\nlast\r\n",
  "continue with offset=",
  "more file(s) not shown",
]) {
  it(`attests a complete file containing ${JSON.stringify(content)}`, async () => {
    const normalized = content.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
    const lines = normalized.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const output =
      normalized === ""
        ? "(empty file)"
        : lines.map((line, index) => `${String(index + 1).padStart(6)}\t${line}`).join("\n");
    const result = await verifyTraceNormativeSources({
      trace: trace(output),
      paths: ["first.txt"],
      readFile: async (path) => ({ path, content }),
    });
    expect(result).toEqual([
      { path: "first.txt", digest: createHash("sha256").update(content).digest("hex") },
    ]);
  });
}

it("rejects stale or incomplete read evidence", async () => {
  const options = {
    trace: trace("     1\tfirst"),
    paths: ["first.txt"],
    readFile: async (path: string) => ({ path, content: "changed" }),
  };
  await expect(verifyTraceNormativeSources(options)).rejects.toThrow("not read completely");
  expect(await verifyTraceNormativeSources({ ...options, allowIncomplete: true })).toEqual([]);
});

it("binds evidence to the requested path", async () => {
  await expect(
    verifyTraceNormativeSources({
      trace: trace("     1\tfirst"),
      paths: ["other.txt"],
      readFile: async (path) => ({ path, content: "first" }),
    }),
  ).rejects.toThrow("not read completely");
});

it("attests a legacy trace without a result digest only when the rendered bytes match", async () => {
  const result = await verifyTraceNormativeSources({
    trace: trace("     1\tfirst", "first.txt", false),
    paths: ["first.txt"],
    readFile: async (path) => ({ path, content: "first" }),
  });
  expect(result).toEqual([
    { path: "first.txt", digest: createHash("sha256").update("first").digest("hex") },
  ]);
});
