import { describe, it, expect } from "../bun-test.ts";
import { settingsServerToEngine } from "../../src/settings/engine-server.ts";
import { mcpServerSettingsSchema } from "../../src/settings/settings-schema.ts";
import { serverSchema } from "../../src/validation/request-schema.ts";
import type { McpServerSettings } from "../../src/settings/settings-schema.ts";

/** Parse a raw settings entry the way the config store does, so `type` carries its default. */
function parse(raw: unknown): McpServerSettings {
  const r = mcpServerSettingsSchema.safeParse(raw);
  if (!r.success) throw new Error(`fixture is not a valid settings entry: ${r.error.message}`);
  return r.data;
}

const MATRIX: { label: string; raw: unknown }[] = [
  { label: "stdio minimal", raw: { type: "stdio", command: "npx" } },
  {
    label: "stdio full",
    raw: {
      type: "stdio",
      command: "npx",
      args: ["-y", "srv"],
      env: { TOKEN: "${TOKEN}" },
      cwd: "/srv/plugin",
      expandVariables: false,
      shared: true,
      resources: false,
    },
  },
  { label: "type omitted", raw: { command: "npx" } },
  { label: "http", raw: { type: "http", url: "https://example.test/mcp" } },
  {
    label: "sse with headers",
    raw: { type: "sse", url: "https://example.test/sse", headers: { Auth: "${A}" } },
  },
  { label: "resources opt-out", raw: { type: "stdio", command: "npx", resources: false } },
  { label: "shared opt-in", raw: { type: "stdio", command: "npx", shared: true } },
];

describe("settingsServerToEngine", () => {
  it.each(MATRIX)("$label round-trips into a request the engine accepts", ({ raw }) => {
    const result = serverSchema.safeParse(settingsServerToEngine("fs", parse(raw)));
    expect(result.success ? "ok" : JSON.stringify(result.error.issues)).toBe("ok");
  });

  it("renames type to transport and keeps the remote fields", () => {
    const out = settingsServerToEngine(
      "docs",
      parse({ type: "http", url: "https://example.test/mcp", headers: { Auth: "${A}" } }),
    );
    expect(out).toEqual({
      name: "docs",
      transport: "http",
      url: "https://example.test/mcp",
      headers: { Auth: "${A}" },
    });
  });

  it("defaults an absent type to stdio", () => {
    expect(settingsServerToEngine("fs", parse({ command: "npx" })).transport).toBe("stdio");
  });

  it("carries portable working-directory and interpolation policy", () => {
    const out = settingsServerToEngine(
      "fs",
      parse({ command: "npx", cwd: "/srv/plugin", expandVariables: false }),
    );
    expect(out.cwd).toBe("/srv/plugin");
    expect(out.expandVariables).toBe(false);
  });

  it("omits absent keys rather than emitting them as undefined", () => {
    const out = settingsServerToEngine("fs", parse({ type: "stdio", command: "npx" }));
    expect(Object.keys(out).sort()).toEqual(["command", "name", "transport"]);
    for (const value of Object.values(out)) expect(value).toBeDefined();
  });

  it("carries the map key through as the tool namespace", () => {
    expect(settingsServerToEngine("my-server", parse({ command: "npx" })).name).toBe("my-server");
  });

  it("carries every settings key the schema declares", () => {
    const full = parse({
      type: "stdio",
      command: "npx",
      args: ["-y"],
      env: { A: "1" },
      cwd: "/srv/plugin",
      expandVariables: false,
      shared: true,
      resources: false,
    });
    const remote = parse({ type: "http", url: "https://example.test/mcp", headers: { A: "1" } });
    const carried = new Set([
      ...Object.keys(settingsServerToEngine("fs", full)),
      ...Object.keys(settingsServerToEngine("fs", remote)),
      "type",
    ]);
    for (const key of Object.keys(mcpServerSettingsSchema.shape)) {
      expect({ key, carried: carried.has(key) }).toEqual({ key, carried: true });
    }
  });
});
