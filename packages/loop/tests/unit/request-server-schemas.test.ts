import { describe, expect, it } from "../bun-test.ts";
import { serverSchema } from "../../src/validation/request/server-schemas.ts";

describe("request server schema", () => {
  it.each([
    [{ name: "fs", command: "server" }, "stdio"],
    [
      {
        name: "fs",
        transport: "stdio",
        command: "server",
        args: ["--stdio"],
        env: { TOKEN: "${TOKEN}" },
        cwd: "/workspace",
        shared: true,
        resources: false,
      },
      "stdio",
    ],
    [
      { name: "remote", transport: "http", url: "https://example.test/mcp", headers: { A: "1" } },
      "http",
    ],
    [{ name: "events", transport: "sse", url: "http://localhost:3000/sse" }, "sse"],
  ] as const)("accepts transport %#", (server, transport) => {
    const parsed = serverSchema.safeParse(server);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.transport).toBe(transport);
  });

  it.each([
    ["stdio without command", { name: "fs" }],
    ["stdio with url", { name: "fs", command: "x", url: "https://example.test" }],
    ["stdio with headers", { name: "fs", command: "x", headers: { A: "1" } }],
    ["remote without url", { name: "r", transport: "http" }],
    ["remote malformed url", { name: "r", transport: "http", url: "not-a-url" }],
    ["remote command", { name: "r", transport: "http", url: "https://e.test", command: "x" }],
    ["remote args", { name: "r", transport: "http", url: "https://e.test", args: [] }],
    ["remote env", { name: "r", transport: "http", url: "https://e.test", env: {} }],
    ["remote cwd", { name: "r", transport: "sse", url: "https://e.test", cwd: "/tmp" }],
    ["remote shared", { name: "r", transport: "sse", url: "https://e.test", shared: false }],
    ["legacy type", { name: "fs", type: "stdio", command: "x" }],
  ])("rejects %s", (_label, server) => {
    expect(serverSchema.safeParse(server).success).toBe(false);
  });

  it("rejects adversarial stdio argument and environment collections", () => {
    expect(
      serverSchema.safeParse({ name: "x", command: "x", args: Array(257).fill("x") }).success,
    ).toBe(false);
    expect(
      serverSchema.safeParse({
        name: "x",
        command: "x",
        env: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`K${index}`, "x"])),
      }).success,
    ).toBe(false);
  });
});
