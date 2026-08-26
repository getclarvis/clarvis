import { expect, test } from "bun:test";
import {
  BACKEND_NAME,
  classifyCapability,
  mcpServerSettingsSchema,
  parseMcpServers,
  promptMessagesToContent,
  reconcile,
  synthSampleArgs,
  type LivePrompt,
  type LiveTool,
} from "../../src/adapters/mcp-capabilities.ts";

test("mcpServerSettingsSchema: stdio needs a command, forbids url/headers", () => {
  expect(mcpServerSettingsSchema.safeParse({ type: "stdio", command: "git-mcp" }).success).toBe(
    true,
  );
  expect(mcpServerSettingsSchema.safeParse({ type: "stdio" }).success).toBe(false);
  expect(
    mcpServerSettingsSchema.safeParse({ type: "stdio", command: "x", url: "https://y" }).success,
  ).toBe(false);
});

test("mcpServerSettingsSchema: http|sse needs a well-formed url, forbids command/args/env/shared", () => {
  expect(
    mcpServerSettingsSchema.safeParse({ type: "http", url: "https://api.example.com" }).success,
  ).toBe(true);
  expect(mcpServerSettingsSchema.safeParse({ type: "http" }).success).toBe(false);
  expect(mcpServerSettingsSchema.safeParse({ type: "http", url: "not-a-url" }).success).toBe(false);
  expect(
    mcpServerSettingsSchema.safeParse({ type: "sse", url: "https://x", command: "y" }).success,
  ).toBe(false);
});

test("mcpServerSettingsSchema: type defaults to stdio; unknown keys rejected (strict)", () => {
  const parsed = mcpServerSettingsSchema.safeParse({ command: "x" });
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data.type).toBe("stdio");
  expect(mcpServerSettingsSchema.safeParse({ command: "x", bogus: 1 }).success).toBe(false);
});

test("parseMcpServers: attaches the record key as name, skips invalid entries", () => {
  const decls = parseMcpServers({
    git: { type: "stdio", command: "git-mcp" },
    web: { type: "http", url: "https://search.example.com" },
    broken: { type: "http" },
  });
  expect(decls.map((d) => d.name).sort()).toEqual(["git", "web"]);
  expect(decls.find((d) => d.name === "git")!.command).toBe("git-mcp");
});

test("classifyCapability: control-plane tools are hidden", () => {
  for (const name of ["run", "steer", "get_run", "list_runs", "delete_run", "list_profiles"])
    expect(classifyCapability(name, "tool").origin).toBe("control-plane");
});

test("classifyCapability: namespaced tool `.` / prompt `:` → downstream, server = prefix", () => {
  expect(classifyCapability("git.status", "tool")).toEqual({
    origin: "downstream",
    server: "git",
    local: "status",
  });
  expect(classifyCapability("git:commit-msg", "prompt")).toEqual({
    origin: "downstream",
    server: "git",
    local: "commit-msg",
  });
});

test("classifyCapability: a bare prompt matching a settings agent → profile-prompt (excluded)", () => {
  expect(classifyCapability("answerer", "prompt", ["answerer", "coder"]).origin).toBe(
    "profile-prompt",
  );
});

test("classifyCapability: a bare prompt NOT matching a profile → skill (bare slash command)", () => {
  expect(classifyCapability("review-diff", "prompt", ["answerer"])).toEqual({
    origin: "skill",
    local: "review-diff",
  });
  expect(classifyCapability("review-diff", "prompt", []).origin).toBe("skill");
  expect(classifyCapability("loose", "tool", []).origin).toBe("downstream");
});

test("reconcile: backend node first, control-plane hidden, status from connection", () => {
  const nodes = reconcile([], [], [], "connected");
  expect(nodes).toHaveLength(1);
  expect(nodes[0]).toMatchObject({
    name: BACKEND_NAME,
    origin: "control-plane",
    status: "connected",
    tools: [],
    prompts: [],
  });
});

test("reconcile: a declared server with no live caps → status 'declared'", () => {
  const nodes = reconcile(
    [{ name: "git", type: "stdio", command: "git-mcp" }],
    [],
    [],
    "connected",
  );
  const git = nodes.find((n) => n.name === "git")!;
  expect(git.status).toBe("declared");
  expect(git.type).toBe("stdio");
  expect(git.tools).toEqual([]);
});

test("reconcile: live tools group by server with the namespace stripped; control-plane excluded", () => {
  const tools: LiveTool[] = [
    { name: "git.status", inputSchema: {} },
    { name: "git.diff", inputSchema: {} },
    { name: "fs.read", inputSchema: {} },
    { name: "run", inputSchema: {} },
  ];
  const nodes = reconcile([], tools, [], "connected");
  const git = nodes.find((n) => n.name === "git")!;
  expect(git.status).toBe("connected");
  expect(git.tools.map((t) => t.name).sort()).toEqual(["diff", "status"]);
  expect(nodes.find((n) => n.name === "fs")!.tools.map((t) => t.name)).toEqual(["read"]);
  expect(nodes.some((n) => n.name === "run")).toBe(false);
});

test("reconcile: profile-prompts are excluded from downstream", () => {
  const prompts: LivePrompt[] = [{ name: "git:commit-msg" }, { name: "answerer" }];
  const nodes = reconcile([], [], prompts, "connected", ["answerer"]);
  expect(nodes.find((n) => n.name === "git")!.prompts.map((p) => p.name)).toEqual(["commit-msg"]);
  expect(nodes.some((n) => n.name === "answerer")).toBe(false);
});

test("reconcile: skills attach to the backend (kernel) node", () => {
  const prompts: LivePrompt[] = [
    { name: "review-diff", description: "Review a diff." },
    { name: "answerer" },
    { name: "git:commit-msg" },
  ];
  const nodes = reconcile([], [], prompts, "connected", ["answerer"]);
  expect(nodes.find((n) => n.name === BACKEND_NAME)!.prompts.map((p) => p.name)).toEqual([
    "review-diff",
  ]);
  expect(nodes.find((n) => n.name === "git")!.prompts.map((p) => p.name)).toEqual(["commit-msg"]);
  expect(nodes.some((n) => n.name === "answerer")).toBe(false);
});

test("promptMessagesToContent: text-only folds to a string; assistant is prefixed", () => {
  expect(promptMessagesToContent([{ role: "user", content: "hi" }])).toBe("hi");
  expect(
    promptMessagesToContent([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]),
  ).toBe("a\n\n[assistant] b");
  expect(promptMessagesToContent([])).toBe("");
});

test("promptMessagesToContent: an image part yields ContentPart[]", () => {
  const out = promptMessagesToContent([
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", mime: "image/png", data: "b64" },
      ],
    },
  ]);
  expect(Array.isArray(out)).toBe(true);
  expect(out).toEqual([
    { type: "text", text: "look" },
    { type: "image", mime: "image/png", data: "b64" },
  ]);
});

test("synthSampleArgs: required fields get type-appropriate placeholders", () => {
  const schema = {
    type: "object",
    properties: { path: { type: "string" }, staged: { type: "boolean" }, n: { type: "number" } },
    required: ["path", "n"],
  };
  expect(synthSampleArgs(schema)).toEqual({ path: "<path>", n: 0 });
  expect(synthSampleArgs({ type: "object", properties: { a: { type: "string" } } })).toEqual({
    a: "<a>",
  });
});
