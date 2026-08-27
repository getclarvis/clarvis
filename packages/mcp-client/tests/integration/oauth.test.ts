import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMCPAuthorizationCoordinator,
  MCPAuthorizationFailedError,
  MCPInteractiveAuthorizationUnavailableError,
  type MCPAuthorizationCoordinator,
} from "@clarvis/mcp-client";

const SCOPE = { workspace: "/workspace/one", owner: "owner-1" };
const SERVER_URL = "https://mcp.example.test/mcp";
const roots: string[] = [];
const coordinators: MCPAuthorizationCoordinator[] = [];

async function coordinator(
  openAuthorizationUrl?: (url: string) => Promise<boolean>,
): Promise<MCPAuthorizationCoordinator> {
  const root = await mkdtemp(join(tmpdir(), "clarvis-mcp-oauth-flow-"));
  roots.push(root);
  const state = join(root, "state");
  await mkdir(state);
  const value = createMCPAuthorizationCoordinator({
    storeFile: join(state, "mcp-oauth.json"),
    callbackPort: 0,
    authorizationTimeoutMs: 2_000,
    ...(openAuthorizationUrl === undefined ? {} : { openAuthorizationUrl }),
  });
  coordinators.push(value);
  return value;
}

afterEach(async () => {
  await Promise.allSettled(coordinators.splice(0).map((value) => value.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MCP OAuth authorization coordinator", () => {
  it("rejects invalid human-authorization timeout configuration", () => {
    expect(() =>
      createMCPAuthorizationCoordinator({
        storeFile: join(tmpdir(), "clarvis-unused-mcp-oauth.json"),
        authorizationTimeoutMs: 0,
      }),
    ).toThrow("positive finite number");
    expect(() =>
      createMCPAuthorizationCoordinator({
        storeFile: join(tmpdir(), "clarvis-unused-mcp-oauth.json"),
        authorizationTimeoutMs: Number.POSITIVE_INFINITY,
      }),
    ).toThrow("positive finite number");
  });

  it("isolates credentials by workspace, owner, and canonical resource URL", async () => {
    const auth = await coordinator();

    expect(auth.key(SCOPE, SERVER_URL)).toBe(auth.key(SCOPE, `${SERVER_URL}/../mcp`));
    expect(auth.key(SCOPE, SERVER_URL)).not.toBe(
      auth.key({ ...SCOPE, workspace: "/workspace/two" }, SERVER_URL),
    );
    expect(auth.key(SCOPE, SERVER_URL)).not.toBe(
      auth.key({ ...SCOPE, owner: "owner-2" }, SERVER_URL),
    );
    expect(auth.key(SCOPE, SERVER_URL)).not.toBe(auth.key(SCOPE, "https://other.example.test/mcp"));
  });

  it("accepts only the matching callback state and exchanges only its code", async () => {
    const opened: string[] = [];
    const auth = await coordinator(async (url) => {
      opened.push(url);
      return true;
    });
    const session = await auth.session(SCOPE, SERVER_URL);
    const state = await session.provider.state?.();
    expect(typeof state).toBe("string");
    await session.provider.saveCodeVerifier("private-verifier");
    await session.provider.redirectToAuthorization(new URL("https://login.example.test/authorize"));
    expect(opened).toEqual(["https://login.example.test/authorize"]);

    const redirect = String(session.provider.redirectUrl);
    const finished: string[] = [];
    const finishing = session.finishAuthorization({
      finishAuth: async (code) => {
        finished.push(code);
        expect(await session.provider.codeVerifier()).toBe("private-verifier");
      },
    });

    const wrong = await fetch(`${redirect}?state=wrong&code=wrong-code`);
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).not.toContain("wrong-code");
    const accepted = await fetch(
      `${redirect}?state=${encodeURIComponent(String(state))}&code=${encodeURIComponent("usable-code")}`,
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).not.toContain("usable-code");
    await finishing;
    expect(finished).toEqual(["usable-code"]);
    expect(() => session.provider.codeVerifier()).toThrow("verifier is unavailable");
  });

  it("persists SDK-validated registration and token records for the same session key", async () => {
    const auth = await coordinator();
    const first = await auth.session(SCOPE, SERVER_URL);
    await first.provider.saveClientInformation?.({ client_id: "registered-client" });
    await first.provider.saveTokens({
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      token_type: "Bearer",
    });

    const second = await auth.session(SCOPE, SERVER_URL);
    expect(await second.provider.clientInformation()).toEqual({ client_id: "registered-client" });
    expect(await second.provider.tokens()).toEqual({
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      token_type: "Bearer",
    });

    await second.provider.invalidateCredentials?.("tokens");
    const third = await auth.session(SCOPE, SERVER_URL);
    expect(await third.provider.clientInformation()).toEqual({ client_id: "registered-client" });
    expect(await third.provider.tokens()).toBeUndefined();
  });

  it("fails explicitly when the host cannot open an authorization page", async () => {
    const auth = await coordinator();
    const session = await auth.session(SCOPE, SERVER_URL);

    await expect(
      session.provider.redirectToAuthorization(new URL("https://login.example.test/authorize")),
    ).rejects.toBeInstanceOf(MCPInteractiveAuthorizationUnavailableError);
  });

  it("refuses a non-loopback plaintext authorization page before opening it", async () => {
    const opened: string[] = [];
    const auth = await coordinator(async (url) => {
      opened.push(url);
      return true;
    });
    const session = await auth.session(SCOPE, SERVER_URL);

    await expect(
      session.provider.redirectToAuthorization(new URL("http://login.example.test/authorize")),
    ).rejects.toBeInstanceOf(MCPAuthorizationFailedError);
    expect(opened).toEqual([]);
  });

  it("propagates an authorization-server refusal without accepting a code", async () => {
    const auth = await coordinator(async () => true);
    const session = await auth.session(SCOPE, SERVER_URL);
    const state = await session.provider.state?.();
    await session.provider.saveCodeVerifier("private-verifier");
    await session.provider.redirectToAuthorization(new URL("https://login.example.test/authorize"));
    const finishing = session.finishAuthorization({ finishAuth: async () => {} });
    const rejection = finishing.catch((error: unknown) => error);

    const declined = await fetch(
      `${String(session.provider.redirectUrl)}?state=${encodeURIComponent(String(state))}&error=access_denied`,
    );
    expect(declined.status).toBe(400);
    expect(await rejection).toBeInstanceOf(MCPAuthorizationFailedError);
  });

  it("serializes authorization work for one resource identity", async () => {
    const auth = await coordinator();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const order: string[] = [];
    const waits: string[] = [];
    const first = auth.runExclusive("same-key", undefined, undefined, undefined, async () => {
      order.push("first:start");
      enteredFirst();
      await firstGate;
      order.push("first:end");
    });
    await firstEntered;
    const second = auth.runExclusive(
      "same-key",
      undefined,
      () => waits.push("start"),
      () => waits.push("end"),
      async () => {
        order.push("second");
      },
    );

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(waits).toEqual(["start", "end"]);
  });

  it("closes a callback listener even when shutdown races its startup", async () => {
    const auth = await coordinator();
    const session = auth.session(SCOPE, SERVER_URL);
    const observed = session.catch((error: unknown) => error);

    await auth.close();

    expect(await observed).toBeInstanceOf(MCPAuthorizationFailedError);
    await expect(auth.session(SCOPE, SERVER_URL)).rejects.toBeInstanceOf(
      MCPAuthorizationFailedError,
    );
  });

  it("starts a fresh state and verifier for a later challenge on the same connection", async () => {
    const opened: string[] = [];
    const auth = await coordinator(async (url) => {
      opened.push(url);
      return true;
    });
    const session = await auth.session(SCOPE, SERVER_URL);
    const states: string[] = [];

    for (const index of [1, 2]) {
      const state = String(await session.provider.state?.());
      states.push(state);
      await session.provider.saveCodeVerifier(`verifier-${String(index)}`);
      await session.provider.redirectToAuthorization(
        new URL(`https://login.example.test/authorize?attempt=${String(index)}`),
      );
      const finishing = session.finishAuthorization({
        finishAuth: async (code) => {
          expect(code).toBe(`code-${String(index)}`);
          expect(await session.provider.codeVerifier()).toBe(`verifier-${String(index)}`);
        },
      });
      const callback = new URL(String(session.provider.redirectUrl));
      callback.searchParams.set("state", state);
      callback.searchParams.set("code", `code-${String(index)}`);
      expect((await fetch(callback)).status).toBe(200);
      await finishing;
    }

    expect(states[0]).not.toBe(states[1]);
    expect(opened).toHaveLength(2);
  });

  it("pairs the opened authorization URL with its own verifier under concurrent starts", async () => {
    const opened: string[] = [];
    const auth = await coordinator(async (url) => {
      opened.push(url);
      return true;
    });
    const session = await auth.session(SCOPE, SERVER_URL);
    const state = String(await session.provider.state?.());
    await session.provider.saveCodeVerifier("first-verifier");
    await session.provider.saveCodeVerifier("second-verifier");
    const authorizationUrl = new URL("https://login.example.test/authorize");
    authorizationUrl.searchParams.set("code_challenge", await pkceChallenge("first-verifier"));
    await session.provider.redirectToAuthorization(authorizationUrl);
    const finishing = session.finishAuthorization({
      finishAuth: async () => {
        expect(await session.provider.codeVerifier()).toBe("first-verifier");
      },
    });
    const callback = new URL(String(session.provider.redirectUrl));
    callback.searchParams.set("state", state);
    callback.searchParams.set("code", "concurrent-code");

    expect((await fetch(callback)).status).toBe(200);
    await finishing;
    expect(opened).toEqual([authorizationUrl.href]);
  });
});

async function pkceChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  return Buffer.from(await crypto.subtle.digest("SHA-256", encoded)).toString("base64url");
}
