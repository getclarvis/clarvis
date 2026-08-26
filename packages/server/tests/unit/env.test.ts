import { describe, it, expect } from "bun:test";
import {
  isLoopbackBind,
  isPrivateBind,
  isPrivateLanBind,
  loadServerEnv,
} from "../../src/config/env.ts";

describe("loadServerEnv", () => {
  it("applies the closed-by-default posture", () => {
    const env = loadServerEnv({});
    expect(env.CLARVIS_SERVER_HOST).toBe("127.0.0.1");
    expect(env.CLARVIS_SERVER_PORT).toBe(8080);
    expect(env.CLARVIS_SERVER_PATH).toBe("/mcp");
    expect(env.CLARVIS_SERVER_OWNER_MODE).toBe("fixed");
    expect(env.CLARVIS_SERVER_OWNER).toBe("default");
    expect(env.CLARVIS_SERVER_ALLOW_REMOTE_GUARD_APPROVAL).toBe(false);
    expect(env.CLARVIS_SERVER_ALLOW_PUBLIC_BIND).toBe(false);
    expect(env.CLARVIS_SERVER_MEMORY).toBe(false);
    expect(env.CLARVIS_SERVER_MAX_SESSIONS).toBe(128);
    expect(env.CLARVIS_SERVER_SESSION_INIT_TIMEOUT_MS).toBe(30_000);
    expect(env.CLARVIS_SERVER_STREAM_BUFFER_BYTES).toBe(8 * 1024 * 1024);
  });

  it("parses the comma-separated lists", () => {
    const env = loadServerEnv({
      CLARVIS_SERVER_ALLOWED_ORIGINS: "https://a.example, https://b.example ",
      CLARVIS_SERVER_READINESS_REQUIRE_MCP: "github,,  slack ",
    });
    expect(env.CLARVIS_SERVER_ALLOWED_ORIGINS).toEqual(["https://a.example", "https://b.example"]);
    expect(env.CLARVIS_SERVER_READINESS_REQUIRE_MCP).toEqual(["github", "slack"]);
  });

  it("rejects a per-owner cap above the global cap, naming the field", () => {
    expect(() =>
      loadServerEnv({ CLARVIS_SERVER_MAX_RUNS: "2", CLARVIS_SERVER_MAX_RUNS_PER_OWNER: "4" }),
    ).toThrow(/CLARVIS_SERVER_MAX_RUNS_PER_OWNER \(4\) must be <= CLARVIS_SERVER_MAX_RUNS \(2\)/);
  });

  it("rejects allowlist mode with an empty allowlist", () => {
    expect(() => loadServerEnv({ CLARVIS_SERVER_OWNER_MODE: "allowlist" })).toThrow(
      /CLARVIS_SERVER_OWNER_ALLOWLIST/,
    );
    expect(
      loadServerEnv({
        CLARVIS_SERVER_OWNER_MODE: "allowlist",
        CLARVIS_SERVER_OWNER_ALLOWLIST: "alice",
      }).CLARVIS_SERVER_OWNER_ALLOWLIST,
    ).toEqual(["alice"]);
  });

  it("rejects a key-sources value that is not a JSON source map", () => {
    expect(() => loadServerEnv({ CLARVIS_SERVER_KEY_SOURCES: "nonsense" })).toThrow(
      /CLARVIS_SERVER_KEY_SOURCES/,
    );
    expect(() => loadServerEnv({ CLARVIS_SERVER_KEY_SOURCES: '{"A":"vault"}' })).toThrow(
      /CLARVIS_SERVER_KEY_SOURCES/,
    );
    expect(
      loadServerEnv({ CLARVIS_SERVER_KEY_SOURCES: '{"A":"keyfile"}' }).CLARVIS_SERVER_KEY_SOURCES,
    ).toEqual({ A: "keyfile" });
  });
});

describe("isPrivateBind", () => {
  it("accepts loopback and RFC1918 addresses", () => {
    for (const host of ["127.0.0.1", "::1", "localhost", "10.1.2.3", "192.168.0.9", "172.16.0.1"]) {
      expect(isPrivateBind(host)).toBe(true);
    }
  });

  it("rejects anything publicly routable, including the wildcard bind", () => {
    for (const host of ["0.0.0.0", "203.0.113.5", "example.com", "172.32.0.1"]) {
      expect(isPrivateBind(host)).toBe(false);
    }
  });
});

/**
 * Loopback and RFC1918 were one category, and that conflation was the defect:
 * binding `192.168.1.20` passed the "private" check in silence and offered
 * unauthenticated command execution to every device on the network. "Private"
 * describes routing, not trust.
 */
describe("isLoopbackBind / isPrivateLanBind", () => {
  it("treats only this-machine addresses as loopback", () => {
    for (const host of ["127.0.0.1", "127.9.9.9", "::1", "localhost"]) {
      expect({ host, loopback: isLoopbackBind(host) }).toEqual({ host, loopback: true });
    }
    for (const host of ["10.1.2.3", "192.168.0.9", "172.16.0.1", "0.0.0.0", "203.0.113.5"]) {
      expect({ host, loopback: isLoopbackBind(host) }).toEqual({ host, loopback: false });
    }
  });

  it("treats RFC1918 as LAN, distinct from loopback", () => {
    for (const host of ["10.1.2.3", "192.168.0.9", "172.16.0.1", "172.31.255.254"]) {
      expect({ host, lan: isPrivateLanBind(host) }).toEqual({ host, lan: true });
    }
    for (const host of ["127.0.0.1", "::1", "localhost", "172.32.0.1", "203.0.113.5"]) {
      expect({ host, lan: isPrivateLanBind(host) }).toEqual({ host, lan: false });
    }
  });

  it("keeps the two disjoint and their union equal to the old predicate", () => {
    for (const host of ["127.0.0.1", "::1", "10.1.2.3", "192.168.0.9", "0.0.0.0", "example.com"]) {
      expect(isLoopbackBind(host) && isPrivateLanBind(host)).toBe(false);
      expect(isLoopbackBind(host) || isPrivateLanBind(host)).toBe(isPrivateBind(host));
    }
  });
});
