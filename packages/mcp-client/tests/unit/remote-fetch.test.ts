import { describe, expect, it } from "bun:test";

import { MCPAuthorizationFailedError } from "../../src/oauth.ts";
import { createMCPRemoteFetch } from "../../src/remote-fetch.ts";

describe("remote MCP fetch authority", () => {
  it("keeps configured resource credentials out of a different OAuth origin", async () => {
    const seen: Array<{ url: string; authorization: string | null; endpointKey: string | null }> =
      [];
    const fetch = createMCPRemoteFetch({
      resourceUrl: new URL("https://resource.example.test/mcp"),
      headers: { Authorization: "Endpoint secret", "X-Endpoint-Key": "resource-only" },
      authorization: true,
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        seen.push({
          url: url.toString(),
          authorization: headers.get("authorization"),
          endpointKey: headers.get("x-endpoint-key"),
        });
        return new Response(null, { status: 200 });
      },
    });

    await fetch("https://resource.example.test/mcp");
    await fetch("https://login.example.test/token", {
      method: "POST",
      headers: { Authorization: "Basic sdk-client" },
    });

    expect(seen).toEqual([
      {
        url: "https://resource.example.test/mcp",
        authorization: "Endpoint secret",
        endpointKey: "resource-only",
      },
      {
        url: "https://login.example.test/token",
        authorization: "Basic sdk-client",
        endpointKey: null,
      },
    ]);
  });

  it("keeps same-origin OAuth requests header-free and preserves SDK credentials", async () => {
    const seen: Array<{ url: string; authorization: string | null; endpointKey: string | null }> =
      [];
    const fetch = createMCPRemoteFetch({
      resourceUrl: new URL("https://shared.example.test/mcp"),
      headers: { Authorization: "Endpoint secret", "X-Endpoint-Key": "resource-only" },
      authorization: true,
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        seen.push({
          url: url.toString(),
          authorization: headers.get("authorization"),
          endpointKey: headers.get("x-endpoint-key"),
        });
        return new Response(null, { status: seen.length === 1 ? 401 : 200 });
      },
    });

    await fetch("https://shared.example.test/mcp");
    await fetch("https://shared.example.test/.well-known/oauth-protected-resource");
    await fetch("https://shared.example.test/token", {
      method: "POST",
      headers: { Authorization: "Basic sdk-client" },
    });
    await fetch("https://shared.example.test/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer sdk-token" },
    });

    expect(seen).toEqual([
      {
        url: "https://shared.example.test/mcp",
        authorization: "Endpoint secret",
        endpointKey: "resource-only",
      },
      {
        url: "https://shared.example.test/.well-known/oauth-protected-resource",
        authorization: null,
        endpointKey: null,
      },
      {
        url: "https://shared.example.test/token",
        authorization: "Basic sdk-client",
        endpointKey: null,
      },
      {
        url: "https://shared.example.test/mcp",
        authorization: "Bearer sdk-token",
        endpointKey: "resource-only",
      },
    ]);
  });

  it("rejects a plaintext non-loopback OAuth fetch before making it", async () => {
    const seen: string[] = [];
    const fetch = createMCPRemoteFetch({
      resourceUrl: new URL("http://resource.example.test/mcp"),
      authorization: true,
      fetch: async (url) => {
        seen.push(url.toString());
        return new Response(null, { status: 401 });
      },
    });

    await fetch("http://resource.example.test/mcp");
    await expect(
      fetch("http://login.example.test/.well-known/oauth-authorization-server"),
    ).rejects.toBeInstanceOf(MCPAuthorizationFailedError);
    expect(seen).toEqual(["http://resource.example.test/mcp"]);
  });

  it("rejects every plaintext OAuth fetch role before making it", async () => {
    const seen: string[] = [];
    const fetch = createMCPRemoteFetch({
      resourceUrl: new URL("https://resource.example.test/mcp"),
      authorization: true,
      fetch: async (url) => {
        seen.push(url.toString());
        return new Response(null, { status: 401 });
      },
    });
    await fetch("https://resource.example.test/mcp");

    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
      "/register",
      "/token",
    ]) {
      await expect(fetch(`http://login.example.test${path}`)).rejects.toBeInstanceOf(
        MCPAuthorizationFailedError,
      );
    }
    expect(seen).toEqual(["https://resource.example.test/mcp"]);
  });

  it("removes configured resource headers before following a cross-origin redirect", async () => {
    const seen: Array<{ url: string; endpointKey: string | null }> = [];
    const fetch = createMCPRemoteFetch({
      resourceUrl: new URL("https://resource.example.test/mcp"),
      headers: { "X-Endpoint-Key": "resource-only" },
      authorization: true,
      fetch: async (url, init) => {
        seen.push({
          url: url.toString(),
          endpointKey: new Headers(init?.headers).get("x-endpoint-key"),
        });
        return seen.length === 1
          ? new Response(null, {
              status: 302,
              headers: { location: "https://login.example.test/discovery" },
            })
          : new Response(null, { status: 200 });
      },
    });

    await fetch("https://resource.example.test/mcp");

    expect(seen).toEqual([
      { url: "https://resource.example.test/mcp", endpointKey: "resource-only" },
      { url: "https://login.example.test/discovery", endpointKey: null },
    ]);
  });

  it("validates an OAuth redirect before following it", async () => {
    const seen: string[] = [];
    const fetch = createMCPRemoteFetch({
      resourceUrl: new URL("https://resource.example.test/mcp"),
      authorization: true,
      fetch: async (url) => {
        seen.push(url.toString());
        if (seen.length === 1) return new Response(null, { status: 401 });
        return new Response(null, {
          status: 302,
          headers: { location: "http://login.example.test/token" },
        });
      },
    });

    await fetch("https://resource.example.test/mcp");
    await expect(
      fetch("https://login.example.test/.well-known/oauth-authorization-server"),
    ).rejects.toBeInstanceOf(MCPAuthorizationFailedError);
    expect(seen).toEqual([
      "https://resource.example.test/mcp",
      "https://login.example.test/.well-known/oauth-authorization-server",
    ]);
  });
});
