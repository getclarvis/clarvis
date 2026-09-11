import { expect, test } from "bun:test";
import { formatToolCall } from "../../src/views/tools/signature.ts";

const sig = (name: string, args: Record<string, unknown>) => formatToolCall(name, "", args);

test("bash renders its command bare — no quotes between the tool name and what it ran", () => {
  expect(sig("shell", { command: "bun test" })).toBe("(bun test)");
});

test("whitelisted secondary args render labelled as key=value after the primaries", () => {
  expect(sig("shell", { command: "bun test", cwd: "packages/code" })).toBe(
    "(bun test, cwd=packages/code)",
  );
  expect(sig("read_file", { path: "a.ts", offset: 1, limit: 20 })).toBe(
    "(a.ts, offset=1, limit=20)",
  );
});

test("non-whitelisted args of a curated tool stay out of the header", () => {
  expect(sig("shell", { command: "sleep 1", timeout_ms: 120000 })).toBe("(sleep 1)");
});

test("grep shows pattern then path, both bare, in that order", () => {
  expect(sig("grep", { pattern: "indigo|#6366f1", path: "frontend/src" })).toBe(
    "(indigo|#6366f1, frontend/src)",
  );
});

test("a long path truncates from the START so the basename survives", () => {
  const path = "/workspaces/monorepo/packages/code/src/views/deeply/nested/blocks.tsx";
  const out = sig("read_file", { path });
  expect(out).toContain("…");
  expect(out.endsWith("blocks.tsx)")).toBe(true);
  expect(out).not.toContain("/workspaces");
});

test("an arg-less list_dir shows its implicit default instead of bare parens", () => {
  expect(sig("list_dir", {})).toBe("(.)");
  expect(sig("list_dir", { path: "src" })).toBe("(src)");
});

test("read_files joins its paths without JSON noise", () => {
  expect(sig("read_files", { paths: ["a.ts", "b.ts"] })).toBe("(a.ts, b.ts)");
});

test("an uncurated MCP tool labels every value instead of dumping positionals", () => {
  expect(formatToolCall("git", "commit", { message: "wip", amend: true })).toBe(
    "(message=wip, amend=true)",
  );
});

test("curated mutation tools show only the path (the change is in the diff below)", () => {
  expect(sig("edit_file", { path: "src/x.ts", old_string: "aaaaa", new_string: "bbbbb" })).toBe(
    "(src/x.ts)",
  );
  expect(sig("write_file", { path: "src/y.ts", content: "a".repeat(500) })).toBe("(src/y.ts)");
  expect(sig("apply_patch", { patch: "@@ ... @@" })).toBe("()");
});

test("long values are truncated with an ellipsis and the whole signature stays capped", () => {
  const out = sig("shell", { command: "x".repeat(200) });
  expect(out).toContain("…");
  expect(out.length).toBeLessThan(80);
});

test("whitespace/newlines in a value collapse to single spaces (one-line header)", () => {
  expect(sig("shell", { command: "npm run build\n  2>&1 | tail" })).toBe(
    "(npm run build 2>&1 | tail)",
  );
});

test("delegate_task leads with the title; the task brief belongs to the card, not the header", () => {
  expect(sig("delegate_task", { title: "explore auth", task: "long brief ".repeat(30) })).toBe(
    "(explore auth)",
  );
});

test("memory writes show only the path — never the markdown content blob", () => {
  expect(sig("write_memory", { path: "PROFILE.md", content: "# Profile\n".repeat(80) })).toBe(
    "(PROFILE.md)",
  );
  expect(
    sig("edit_memory", { path: "infra/TOPIC.md", old_string: "aaaaa", new_string: "bbbbb" }),
  ).toBe("(infra/TOPIC.md)");
  expect(sig("delete_memory", { path: "infra/bun/MEMORY.md" })).toBe("(infra/bun/MEMORY.md)");
});

test("memory reads lead with what was asked for", () => {
  expect(sig("read_memory", { paths: ["PROFILE.md", "infra/TOPIC.md"] })).toBe(
    "(PROFILE.md, infra/TOPIC.md)",
  );
  expect(sig("list_memories", { prefix: "infra/" })).toBe("(infra/)");
  expect(sig("grep_memories", { query: "bun install", regex: true, limit: 20 })).toBe(
    "(bun install, regex=true)",
  );
});

test("configuration calls show their authored scope and path without mutation payloads", () => {
  expect(
    sig("configure_clarvis", {
      operation: "write",
      root: "workspace_clarvis",
      path: "agents/reviewer.md",
      content: "secret body",
      expected_revision: "revision",
    }),
  ).toBe("(.clarvis/agents/reviewer.md)");
  expect(
    sig("configure_clarvis", {
      operation: "read",
      root: "global_agents",
      path: "skills/reviewer/SKILL.md",
    }),
  ).toBe("(global:.agents/skills/reviewer/SKILL.md)");
  expect(sig("configure_clarvis", { operation: "list", root: "workspace_agents", path: "" })).toBe(
    "(.agents)",
  );
});
