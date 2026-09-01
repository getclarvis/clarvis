import { describe, it, expect } from "bun:test";
import {
  buildRegistry as build,
  selectTools,
  poolToolNames,
  toWireToolName,
} from "@clarvis/mcp-client";
import type { RegistryEntry } from "@clarvis/mcp-client";
import type { MCPConnection } from "@clarvis/capability";

const WIRE_SAFE = /^[a-zA-Z0-9_-]+$/;

/**
 * A stand-in for a host's reserved wire names. The real list is the engine's
 * vocabulary and lives there; this package only has to honour whatever it is
 * handed.
 */
const RESERVED: readonly string[] = ["submit_result", "ask_user", "load_skill", "read_file"];

/** {@link build} with the fixture's reserved names, so each case reads as before. */
function buildRegistry(entries: RegistryEntry[]) {
  return build(entries, RESERVED);
}

function fakeConn(name: string): MCPConnection {
  return {
    name,
    transport: "stdio",
    status: "connected",
    async callTool() {
      return { ok: true, data: { from: name } };
    },
    async close() {},
  };
}

describe("registry", () => {
  it("namespaces tools across MCPs with no collisions", () => {
    const reg = buildRegistry([
      {
        conn: fakeConn("fs"),
        tools: [
          { name: "read", inputSchema: { type: "object" } },
          { name: "write", inputSchema: { type: "object" } },
        ],
      },
      {
        conn: fakeConn("net"),
        tools: [{ name: "read", inputSchema: { type: "object" } }],
      },
    ]);

    expect(reg.tools.map((t) => t.fullName).sort()).toEqual(
      ["fs.read", "fs.write", "net.read"].sort(),
    );
  });

  it("never assigns a reserved wire name (submit_result/ask_user) to an MCP tool", () => {
    const reg = buildRegistry([
      { conn: fakeConn("submit"), tools: [{ name: "result", inputSchema: { type: "object" } }] },
      { conn: fakeConn("ask"), tools: [{ name: "user", inputSchema: { type: "object" } }] },
    ]);
    const wireNames = reg.tools.map((t) => t.wireName);
    expect(wireNames).not.toContain("submit_result");
    expect(wireNames).not.toContain("ask_user");
    expect(reg.resolve("submit.result")).not.toBeNull();
    expect(reg.resolve("ask.user")).not.toBeNull();
  });

  it("resolve() returns the matching connection and tool name", () => {
    const fs = fakeConn("fs");
    const reg = buildRegistry([
      { conn: fs, tools: [{ name: "read", inputSchema: { type: "object" } }] },
    ]);
    const r = reg.resolve("fs.read");
    expect(r).not.toBeNull();
    expect(r?.connection).toBe(fs);
    expect(r?.toolName).toBe("read");
  });

  it("resolve() returns null for an unknown tool", () => {
    const reg = buildRegistry([
      { conn: fakeConn("fs"), tools: [{ name: "read", inputSchema: {} }] },
    ]);
    expect(reg.resolve("fs.missing")).toBeNull();
    expect(reg.resolve("missing.read")).toBeNull();
  });

  it("allUnavailable returns false when no MCPs are configured", () => {
    const reg = buildRegistry([]);
    expect(reg.allUnavailable()).toBe(false);
  });

  it("allUnavailable is true only when EVERY connection is unavailable", () => {
    const down = { ...fakeConn("fs"), status: "unavailable" as const };
    const up = fakeConn("net");
    const tool = { name: "read", description: "d", inputSchema: { type: "object" } };

    // One healthy server is enough for the pool to be usable — "all" is the
    // whole predicate, and an `.some` written here would strand a run whose
    // other servers are fine.
    expect(buildRegistry([{ conn: down, tools: [tool] }]).allUnavailable()).toBe(true);
    expect(
      buildRegistry([
        { conn: down, tools: [tool] },
        { conn: up, tools: [tool] },
      ]).allUnavailable(),
    ).toBe(false);
    expect(buildRegistry([{ conn: up, tools: [tool] }]).allUnavailable()).toBe(false);
  });
});

describe("toWireToolName — canonical wire-safe projection", () => {
  it("strips characters outside the industry-standard tool-name charset", () => {
    const wire = toWireToolName("fs.read_file", new Set());
    expect(wire).toMatch(WIRE_SAFE);
    expect(wire).not.toContain(".");
  });

  it("disambiguates names that sanitize to the same form", () => {
    const used = new Set<string>();
    const first = toWireToolName("a.b", used);
    const second = toWireToolName("a_b", used);
    expect(first).not.toBe(second);
    expect(first).toMatch(WIRE_SAFE);
    expect(second).toMatch(WIRE_SAFE);
  });

  it("treats caller-owned names case-insensitively while adding the exact chosen name", () => {
    const used = new Set(["SEARCH"]);
    expect(toWireToolName("search", used)).toBe("search_1");
    expect(used.has("search_1")).toBe(true);
  });
});

describe("registry wireName ↔ fullName round-trip", () => {
  it("preserves a unique provider-safe local name for skill/tool compatibility", () => {
    const reg = buildRegistry([
      {
        conn: fakeConn("miro:miro"),
        tools: [{ name: "diagram_create_mermaid", inputSchema: { type: "object" } }],
      },
    ]);
    expect(reg.tools[0]!.wireName).toBe("diagram_create_mermaid");
    expect(reg.resolve("diagram_create_mermaid")?.fullName).toBe(
      "miro:miro.diagram_create_mermaid",
    );
  });

  it("exposes a wire-safe name for every tool while keeping the dotted fullName", () => {
    const reg = buildRegistry([
      { conn: fakeConn("fs"), tools: [{ name: "read_file", inputSchema: { type: "object" } }] },
    ]);
    const tool = reg.tools[0]!;
    expect(tool.fullName).toBe("fs.read_file");
    expect(tool.wireName).toMatch(WIRE_SAFE);
    expect(tool.wireName).not.toContain(".");
  });

  it("resolve(wireName) returns the connection, tool name, and canonical fullName", () => {
    const fs = fakeConn("fs");
    const reg = buildRegistry([
      { conn: fs, tools: [{ name: "read_file", inputSchema: { type: "object" } }] },
    ]);
    const wireName = reg.tools[0]!.wireName;

    const r = reg.resolve(wireName);
    expect(r).not.toBeNull();
    expect(r?.connection).toBe(fs);
    expect(r?.toolName).toBe("read_file");
    expect(r?.fullName).toBe("fs.read_file");
  });

  it("resolve() still accepts the dotted fullName (internal callers / dot-preserving providers)", () => {
    const reg = buildRegistry([
      { conn: fakeConn("fs"), tools: [{ name: "read_file", inputSchema: {} }] },
    ]);
    expect(reg.resolve("fs.read_file")?.toolName).toBe("read_file");
  });

  it("keeps wireNames unique and resolvable when tools collide after sanitizing", () => {
    const a = fakeConn("a.b");
    const b = fakeConn("a");
    const reg = buildRegistry([
      { conn: a, tools: [{ name: "c", inputSchema: {} }] },
      { conn: b, tools: [{ name: "b_c", inputSchema: {} }] },
    ]);
    const wireNames = reg.tools.map((t) => t.wireName);
    expect(new Set(wireNames).size).toBe(2);
    expect(reg.resolve(wireNames[0]!)?.connection).toBe(a);
    expect(reg.resolve(wireNames[1]!)?.connection).toBe(b);
  });

  it("falls back to namespaced names when local names collide across servers", () => {
    const reg = buildRegistry([
      { conn: fakeConn("alpha"), tools: [{ name: "search", inputSchema: {} }] },
      { conn: fakeConn("beta"), tools: [{ name: "SEARCH", inputSchema: {} }] },
    ]);
    expect(reg.tools.map((tool) => tool.wireName)).toEqual(["alpha_search", "beta_SEARCH"]);
  });

  it("reserves a unique local name before allocating colliding namespaced fallbacks", () => {
    const entries = [
      { conn: fakeConn("alpha"), tools: [{ name: "search", inputSchema: {} }] },
      { conn: fakeConn("beta"), tools: [{ name: "SEARCH", inputSchema: {} }] },
      { conn: fakeConn("gamma"), tools: [{ name: "alpha_search", inputSchema: {} }] },
    ];
    for (const ordered of [entries, [...entries].reverse()]) {
      const reg = buildRegistry(ordered);
      expect(reg.resolve("alpha_search")?.fullName).toBe("gamma.alpha_search");
      expect(new Set(reg.tools.map((tool) => tool.wireName.toLowerCase())).size).toBe(3);
    }
  });

  it("an MCP tool that sanitizes to a reserved built-in coding-tool name is disambiguated", () => {
    const reg = buildRegistry([
      { conn: fakeConn("fs"), tools: [{ name: "read_file", inputSchema: { type: "object" } }] },
    ]);
    const tool = reg.tools.find((t) => t.fullName === "fs.read_file")!;
    expect(tool.wireName).not.toBe("read_file");
    expect(tool.wireName).toMatch(WIRE_SAFE);
  });
});

describe("registry case-insensitive dedupe", () => {
  it("keeps the first resolved entry when wire and full names collide only by case", () => {
    const upper = fakeConn("FS");
    const lower = fakeConn("fs");
    const reg = buildRegistry([
      { conn: upper, tools: [{ name: "read", inputSchema: { type: "object" } }] },
      { conn: lower, tools: [{ name: "read", inputSchema: { type: "object" } }] },
    ]);

    expect(reg.resolve("FS.read")?.connection).toBe(upper);
    expect(reg.resolve("fs.read")?.connection).toBe(lower);
    expect(reg.resolve("Fs.Read")?.connection).toBe(upper);
    expect(reg.resolve("FS_READ")?.connection).toBe(upper);
  });
});

describe("selectTools and poolToolNames", () => {
  const entries: RegistryEntry[] = [
    {
      conn: fakeConn("fs"),
      tools: [
        { name: "read", inputSchema: { type: "object" } },
        { name: "write", inputSchema: { type: "object" } },
      ],
    },
    {
      conn: fakeConn("net"),
      tools: [{ name: "fetch", inputSchema: { type: "object" } }],
    },
  ];

  it("returns every entry unchanged when names is undefined", () => {
    expect(selectTools(entries)).toBe(entries);
  });

  it("keeps only the requested tools and drops entries with no match", () => {
    const selected = selectTools(entries, ["fs.read"]);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.conn.name).toBe("fs");
    expect(selected[0]!.tools.map((t) => t.name)).toEqual(["read"]);
  });

  it("poolToolNames lists every namespaced tool", () => {
    expect(poolToolNames(entries)).toEqual(["fs.read", "fs.write", "net.fetch"]);
  });
});

describe("registry — the host's reserved names are honoured, whatever they are", () => {
  it("a unique local tool name is preserved even when its full-name projection is reserved", () => {
    const reg = buildRegistry([
      { conn: fakeConn("load"), tools: [{ name: "skill", inputSchema: { type: "object" } }] },
    ]);
    expect(reg.tools[0]!.wireName).toBe("skill");
  });

  it("reserves nothing when the host reserves nothing", () => {
    const reg = build(
      [{ conn: fakeConn("load"), tools: [{ name: "skill", inputSchema: { type: "object" } }] }],
      [],
    );
    expect(reg.tools[0]!.wireName).toBe("skill");
  });
});
